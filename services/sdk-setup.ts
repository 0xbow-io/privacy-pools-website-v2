import {
  CryptoService,
  PoseidonHashService,
  MerkleService,
  ProofService,
  Groth16Prover,
  WitnessPreparationService,
  NoteComputationService,
  NoteManager,
  KeystoreManager,
  ASPClient,
  ASPRegistryInteractor,
  DEPLOYMENTS,
  HttpASPDataProvider,
  ViemRPCInteractor,
  createEvmEntrypointInteractor,
  createEvmPoolVaultInteractor,
  createEvmKeystoreInteractor,
  RelayerInteractor,
  AddressSchema,
} from '@privacy-pools-v2/sdk';
import { WorkerGroth16Prover } from './worker-groth16-prover';
import { WorkerWitnessPreparationService } from './worker-witness-preparation';
import type {
  ICryptoService,
  IHashService,
  IMerkleService,
  IProofService,
  IWitnessPreparationService,
  INoteManager,
  IKeystoreManager,
  IASPClient,
  IASPDataProvider,
  IASPRegistryInteractor,
  IRelayerInteractor,
  FinalizedBlockResult,
  IRPCInteractor,
  IEntrypointInteractor,
  IPoolVaultInteractor,
  IKeystoreInteractor,
  INoteComputationService,
  ICircuitArtifacts,
  IHTTPClient,
  KeystoreManagerConfig,
  Address,
  Hash,
  Hex,
  PublicKey,
  HTTPRequestOptions,
} from '@privacy-pools-v2/sdk';
import { createPublicClient, isAddress, keccak256, toBytes, toHex, bytesToHex } from 'viem';
import { VIEM_CHAIN_BY_ID } from '@/config/wagmi-chain-map';
import { policedHttp } from '@/services/egress-transport';
import { x25519 } from '@noble/curves/ed25519.js';
import { derivePasskeyKeysFromHex } from './passkey-derivation';
import { APP_IDENTIFIER } from '@privacy-pools-v2/sdk';
import { createOnChainNoteIndex, type OnChainNoteIndex } from '@/services/onchain-note-index';
import { classifyPoolRead, routePoolRead } from '@/services/pool-read-router';
import { isRelayedTxHash, recordRelayedHashes, waitForRelayedReceipt, type RawLogClient, type RelayHooks } from '@/services/relayed-receipt';
import { relayRequestNullifiers } from '@/services/pending-relays-core';
import { checkTransferRelay } from '@/services/transfer-relay-outputs';
import {
  assertNoPendingRelay,
  commitRelayReservation,
  releaseRelayReservation,
  reserveRelayNullifiers,
  settlePendingRelayByReceipt,
} from '@/services/pending-relays-store';
import { alignLogScanStart } from '@/services/log-scan-alignment';
import { getChainConfig } from '@/config/chains';
import { ASP_PUBLIC_KEY, ASP_URL, LEGACY_CONFIG } from '@/config/env';
import { getRelayerSignerAddress, getTransferProcessorAddress } from '@/config/relayer';
import type { AspLeafRow } from '@/services/api-client';
import { noteEventsFromSnapshot, SNAPSHOT_NOTE_OVERLAP_BLOCKS, snapshotCursor } from '@/services/asp-event-snapshot';
import { loadPoolEventSnapshot, loadPoolLeaves } from '@/services/snapshot-source';
import { createRangeWindow, sweepLogRange, type RangeWindow } from '@/services/rpc-log-chunking';
import { createLogCoalescer, type LogCoalescer } from '@/services/log-coalescer';
import { createBlockNumberMemo } from '@/services/block-number-memo';
import { blockTimeMs } from '@/services/chain-block-time';
import { approvedLabelCache, bulkApprovedLabels, getPoolLabelDecisions, heldAspPublicKey, normalizeHashString } from '@/services/public-asp-cache';
export { getPoolAssociationSetLeaves, getPoolBlockedLabelHashes } from '@/services/public-asp-cache';
import { resolveConfiguredEntrypoint } from '@/services/pool-entrypoint';
import { emitTransactProofGenerated } from '@/services/proof-progress';
import { recordAspBlockTimestamps } from '@/services/asp-block-timestamps';
import { FetchHTTPClient } from '@/services/egress-http-client';
import { ARTIFACTS_VERSION } from '@/config/artifacts';
import { isStaleAssetResponse, reportStaleAssets, STALE_ASSETS_ERROR } from '@/services/stale-assets';

// ---------------------------------------------------------------------------
// Primitive / stateless services
// ---------------------------------------------------------------------------

export function createCryptoService(): ICryptoService {
  return new CryptoService();
}

// One Poseidon per page. It is stateless, and each instance allocates its own
// WebAssembly memory that is only released when garbage collected, so building
// one per pool session (every chain switch, sign-in and cross-chain leg) grew
// the tab until WebAssembly.Memory() could not allocate (Mike 2026-10-13).
let hashServicePromise: Promise<IHashService> | null = null;
export async function createHashService(): Promise<IHashService> {
  if (!hashServicePromise) {
    hashServicePromise = PoseidonHashService.create();
    // A failed init is not cached: the next caller retries.
    hashServicePromise.catch(() => { hashServicePromise = null; });
  }
  return hashServicePromise;
}

export function createMerkleService(hashService: IHashService): IMerkleService {
  return new MerkleService({ hashService });
}

// Stateless Poseidon commitment chain — used by the audit-receipt
// verifier to recompute a note's commitment from a revealed
// (ownerAddress, noteSecret, tokenId, value, label) bundle.
export async function createNoteComputationService(): Promise<INoteComputationService> {
  const hashService = await createHashService();
  const cryptoService = createCryptoService();
  return new NoteComputationService({ hashService, cryptoService });
}

// Singleton so we only spawn one worker per page — Groth16Prover holds
// no proof-specific state, and the worker stays warm between proofs.
let cachedProver: ReturnType<typeof pickProver> | null = null;
function pickProver() {
  if (typeof window !== 'undefined' && typeof Worker !== 'undefined') {
    return new WorkerGroth16Prover();
  }
  return new Groth16Prover();
}
export function createGroth16Prover() {
  if (!cachedProver) cachedProver = pickProver();
  return cachedProver;
}

// Fast Refresh / HMR: terminate the previous module's worker before the
// replacement module instantiates a new one. Without this each save in
// dev orphans the old worker (and its nested snarkjs workers) until a
// hard reload. Production builds don't ship with module.hot, so this is
// a no-op there.
declare const module: { hot?: { dispose?: (cb: () => void) => void } };
if (typeof module !== 'undefined' && module.hot && typeof module.hot.dispose === 'function') {
  module.hot.dispose(() => {
    const prover = cachedProver as { dispose?: () => void } | null;
    prover?.dispose?.();
    cachedProver = null;
  });
}

export function createProofService(circuitArtifacts: ICircuitArtifacts): IProofService {
  const service = new ProofService({
    circuitArtifacts,
    groth16Prover: createGroth16Prover(),
  });
  // Pass-through delegate whose only addition is a progress tick per completed
  // transact proof (services/proof-progress.ts). The SDK's batch-withdraw
  // orchestrator generates one proof per note group with no callback, so this
  // is the hook the withdraw modal's "proof i of N" progress bar hangs off.
  // Behavior is otherwise identical — every method forwards to the real
  // ProofService and the emit can never throw into the proving path.
  return {
    loadCircuit: (circuitName) => service.loadCircuit(circuitName),
    proveDeposit: (witness) => service.proveDeposit(witness),
    proveTransact: async (witness, nInputs, mOutputs) => {
      const proof = await service.proveTransact(witness, nInputs, mOutputs);
      emitTransactProofGenerated();
      return proof;
    },
    proveRagequit: (witness) => service.proveRagequit(witness),
    verifyDeposit: (proof) => service.verifyDeposit(proof),
    verifyTransact: (proof, nInputs, mOutputs) => service.verifyTransact(proof, nInputs, mOutputs),
    verifyRagequit: (proof) => service.verifyRagequit(proof),
    formatForChain: (proofResult) => service.formatForChain(proofResult),
  };
}

export function createWitnessService(
  hashService: IHashService,
  merkleService: IMerkleService,
  cryptoService: ICryptoService,
): IWitnessPreparationService {
  const noteComputationService = new NoteComputationService({ hashService, cryptoService });
  const inThread = new WitnessPreparationService({ hashService, merkleService, noteComputationService });
  // Wrap the in-thread service in a worker-backed proxy so the SDK's
  // pre-proof Poseidon hashing (3 merkle proofs per input note ≈ several
  // seconds of synchronous BigInt math) doesn't freeze the UI. Falls
  // through to `inThread` if Worker is unavailable.
  return new WorkerWitnessPreparationService(inThread);
}

export function createNoteManager(): INoteManager {
  const nm = new NoteManager({}) as INoteManager & {
    updateNoteStatus: (commitment: Hash, status: string, currentBlock?: unknown) => void;
  };
  // SDK workaround: PoolSessionNoteDiscovery.processRagequitEvents re-applies
  // the full ASP event snapshot on every discover call, which retries
  // EXITED -> EXITED on already-exited notes and throws
  // InvalidStatusTransitionError, aborting the scan. Swallow invalid-transition
  // errors so rediscovery stays idempotent. Remove once the SDK guards this.
  const originalUpdate = nm.updateNoteStatus.bind(nm);
  nm.updateNoteStatus = (commitment, status, currentBlock) => {
    try {
      originalUpdate(commitment, status, currentBlock);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('Invalid status transition')) throw err;
    }
  };
  return nm;
}

export function createKeystoreManager(config: KeystoreManagerConfig): IKeystoreManager {
  return new KeystoreManager(config);
}

// Canonical Signature-Based Derivation payload — mirrors the SDK's
// reference shape (apps/sample/src/keystore/secretDerivationPayload.ts).
// The SDK dropped its own buildSecretDerivationPayload helper, so the
// integrator owns the EIP-712 construction; the SDK only consumes the
// resulting (signature, signerAddress, addressHash) tuple via
// KeystoreManager.fromSignature / CryptoService.deriveKeysFromSignature.
//
// `purpose` is part of the typed-data hash → part of the derivation, so
// it must stay byte-for-byte identical to the SDK reference string.
const SECRET_DERIVATION_PURPOSE =
  'This signature is used to deterministically derive application-specific secrets from your master seed. It is not a transaction and will not cost any gas.';

export function buildSecretDerivationPayload(signerAddress: Address) {
  const addressHash = keccak256(toBytes(signerAddress)) as Hex;
  // keccak256(toHex(str)) === keccak256(toBytes(str)) — both hash the
  // UTF-8 bytes; we use toHex to match the SDK sample verbatim.
  const salt = keccak256(toHex(APP_IDENTIFIER)) as Hex;
  return {
    domain: {
      name: 'Standardized Secret Derivation',
      version: '1',
      verifyingContract: '0x0000000000000000000000000000000000000000' as Address,
      salt,
    },
    message: {
      purpose: SECRET_DERIVATION_PURPOSE,
      addressHash,
    },
    primaryType: 'SecretDerivation' as const,
    types: {
      SecretDerivation: [
        { name: 'purpose', type: 'string' },
        { name: 'addressHash', type: 'bytes32' },
      ],
    },
  };
}

// Build a KeystoreManager from a wallet signature over the canonical
// derivation payload (HKDF, the SDK/sample-web way). Replaces ppv2's old
// hand-rolled keccak derivation. revocableKeyIndex is 0x0 until rotation
// is implemented.
export function createKeystoreManagerFromSignature(params: {
  signature: Hex;
  signerAddress: Address;
  addressHash: Hex;
  revocableKeyIndex: Hex;
}): IKeystoreManager {
  return KeystoreManager.fromSignature(params, { cryptoService: createCryptoService() });
}

// ---------------------------------------------------------------------------
// LEGACY (pre-2026-05-20) keccak derivation — Sepolia migration shim ONLY.
//
// Before the HKDF cutover, ppv2 derived keys by hashing segments of an
// EIP-712 "DeriveSeed" signature: keccak256(0x01‖r) / (0x02‖r) / (0x03‖s).
// The Keystore contract's nullifying key is WRITE-ONCE, so any wallet that
// registered under this scheme is permanently bound to these keys and can
// only spend with them. We keep this derivation so the app can detect such
// wallets (by matching the on-chain nullifyingKeyHash) and transact for them.
//
// Sepolia-only: no mainnet / new deployment ever registered keccak keys, so
// callers MUST gate this on chainId === 11155111. See sdk-provider.
export function buildLegacyKeccakDerivationPayload(signerAddress: Address) {
  return {
    domain: { name: 'Privacy Pools', version: '1' } as const,
    types: {
      DeriveSeed: [
        { name: 'action', type: 'string' },
        { name: 'context', type: 'string' },
        { name: 'addressHash', type: 'bytes32' },
      ],
    },
    primaryType: 'DeriveSeed' as const,
    message: {
      action: 'Derive Account Seed',
      context: 'privacy-pools/wallet-seed:v2',
      addressHash: keccak256(toBytes(signerAddress)) as Hex,
    },
  };
}

// Passkey-derived keystore manager. Mirrors the legacy-keccak shim's shape: it
// derives the three keys off-chain (here from a WebAuthn PRF secret, via the
// SDK's exact HKDF tree — see services/passkey-derivation.ts) and hands them to
// the public KeystoreManager constructor. No SDK modification and no signature:
// a passkey account is just another derivation scheme alongside HKDF-signature
// and legacy-keccak, distinguished on-chain by its nullifying-key hash.
//
// revocableKeyIndex stays 0x0 until rotation is wired (the SDK's built-in
// rotation is signature-shaped). The derivation must be frozen before any real
// account registers (write-once nullifying key) — gate real onboarding on that.
export function derivePasskeyKeystoreManager(prfSecret: Hex, revocableKeyIndex: Hex = '0x0' as Hex): IKeystoreManager {
  const keys = derivePasskeyKeysFromHex(prfSecret, BigInt(revocableKeyIndex));
  return createKeystoreManager({
    privateNullifyingKey: keys.privateNullifyingKey,
    privateRevocableKey: keys.privateRevocableKey,
    viewingPrivateKey: keys.viewingPrivateKey,
    viewingPublicKey: keys.viewingPublicKey,
    revocableKeyIndex,
  });
}

export function deriveLegacyKeccakKeystoreManager(signature: Hex): IKeystoreManager {
  const clean = signature.startsWith('0x') ? signature.slice(2) : signature;
  const rHex = clean.slice(0, 64);
  const sHex = clean.slice(64, 128);
  const viewingPrivateKey = keccak256(toBytes(('0x03' + sHex) as Hex)) as Hex;
  return createKeystoreManager({
    privateNullifyingKey: keccak256(toBytes(('0x01' + rHex) as Hex)) as Hex,
    privateRevocableKey: keccak256(toBytes(('0x02' + rHex) as Hex)) as Hex,
    viewingPrivateKey,
    viewingPublicKey: bytesToHex(x25519.getPublicKey(toBytes(viewingPrivateKey))) as Hex,
    revocableKeyIndex: '0x0' as Hex,
  });
}

// ---------------------------------------------------------------------------
// HTTP client for the ASP data provider
// ---------------------------------------------------------------------------

// The vendored SDK's HttpASPDataProvider builds its association-set / labels /
// event-snapshot URLs with only `chainId` and cannot pass an `entrypoint`. On
// a chain hosting more than one pool, asp-v2 needs the entrypoint to know
// WHICH pool's association set, label status, and snapshot to serve — without
// it the proof path would fetch the wrong/ambiguous data. The website already
// passes the entrypoint on its own apiClient calls; this wrapper closes the
// same gap on the SDK's proof-path GETs by appending the resolved entrypoint
// to exactly those URLs (preserving all of the SDK's response parsing).
//
// Harmless while a chain is single-pool: the param is optional and the ASP
// ignores it (verified: /association-set/root|leaves return byte-identical
// bodies with and without it). post/getBinary pass through untouched. On a
// resolution failure we fall back to the un-scoped URL (current behaviour).
function createEntrypointScopedHttpClient(
  inner: IHTTPClient,
  chainId: number,
  snapshot?: { url: string; load: () => Promise<unknown> },
): IHTTPClient {
  const needsScope = (url: string) =>
    url.includes('/association-set/') || url.includes('/labels/') || url.includes('/event-snapshot');
  const scopeUrl = async (url: string): Promise<string> => {
    if (!needsScope(url)) return url;
    // v2.0 migration: the SDK's HttpASPDataProvider now appends its own
    // `entrypoint=` (root/leaves/event-snapshot/note-events). Don't double
    // the param — this wrapper only still covers URLs the SDK leaves
    // un-scoped (e.g. /labels/{label}/status).
    // One spelling on the wire (lowercase), the same one APIClient sends, so
    // the SDK's requests and the app's are the same request.
    if (/[?&]entrypoint=/.test(url)) {
      return url.replace(/([?&]entrypoint=)(0x[0-9a-fA-F]{40})/, (_, key: string, address: string) => `${key}${address.toLowerCase()}`);
    }
    let entrypoint: string | undefined;
    try {
      entrypoint = await resolveConfiguredEntrypoint(chainId);
    } catch {
      return url;
    }
    if (!entrypoint) return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}entrypoint=${encodeURIComponent(entrypoint.toLowerCase())}`;
  };
  return {
    async get<T>(url: string, options?: HTTPRequestOptions): Promise<T> {
      if (snapshot && url === snapshot.url) return await snapshot.load() as T;
      return inner.get<T>(await scopeUrl(url), options);
    },
    post<T>(url: string, body: unknown, options?: HTTPRequestOptions): Promise<T> {
      return inner.post<T>(url, body, options);
    },
    getBinary(url: string, options?: HTTPRequestOptions): Promise<Uint8Array> {
      return inner.getBinary(url, options);
    },
  };
}

function isCompressedSecp256k1PublicKey(value: string | undefined): value is PublicKey {
  return typeof value === 'string' && /^0x(?:02|03)[0-9a-fA-F]{64}$/.test(value);
}

// ---------------------------------------------------------------------------
// Circuit artifacts fetched over HTTP (browser/RN compatible)
// ---------------------------------------------------------------------------

class RemoteCircuitArtifacts implements ICircuitArtifacts {
  constructor(private readonly baseUrl: string) {}

  async getWasm(circuitName: string): Promise<Uint8Array> {
    return this.fetchBinary(`${this.baseUrl}/${circuitName}/${circuitName}_js/${circuitName}.wasm`);
  }

  async getProvingKey(circuitName: string): Promise<Uint8Array> {
    return this.fetchBinary(`${this.baseUrl}/${circuitName}/groth16_pkey.zkey`);
  }

  async getVerificationKey(circuitName: string): Promise<Uint8Array> {
    return this.fetchBinary(`${this.baseUrl}/${circuitName}/groth16_vkey.json`);
  }

  private async fetchBinary(url: string): Promise<Uint8Array> {
    const response = await fetch(url);
    if (!response.ok) {
      // A versioned URL that 404s is a tab older than the deployed circuits: say so.
      if (isStaleAssetResponse({ versioned: ARTIFACTS_VERSION !== '', status: response.status })) {
        reportStaleAssets();
        throw new Error(`${STALE_ASSETS_ERROR} (${response.status})`);
      }
      throw new Error(`Failed to fetch circuit artifact: ${response.status} ${url}`);
    }
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
}

export function createCircuitArtifacts(baseUrl: string): ICircuitArtifacts {
  return new RemoteCircuitArtifacts(baseUrl);
}

// ---------------------------------------------------------------------------
// ASP client
// ---------------------------------------------------------------------------

// v2.0 migration: HttpASPDataProvider now requires the pool's entrypoint
// address at construction (the ASP hosts several pools per chain and scopes
// association-set / event queries by it). Resolve it from the live ASP
// /entrypoints feed — same source the rest of the app uses — and fall back
// to the SDK's canonical DEPLOYMENTS constant when the feed is unavailable.
async function resolveEntrypointAddressForProvider(chainId: number): Promise<Address> {
  if (LEGACY_CONFIG) return LEGACY_CONFIG.entrypoint as Address;
  try {
    const resolved = await resolveConfiguredEntrypoint(chainId);
    if (resolved && isAddress(resolved)) return resolved as Address;
  } catch {
    // fall through to the static deployment constant
  }
  const fallback = DEPLOYMENTS[chainId]?.entrypointAddress;
  if (fallback) return fallback;
  throw new Error(`Cannot resolve an entrypoint address for chain ${chainId}`);
}

const aspLeafPoolKeys = new WeakMap<IASPDataProvider, string>();

export async function createASPDataProvider(chainId: number): Promise<IASPDataProvider> {
  const httpClient = new FetchHTTPClient('asp', ASP_URL);
  const entrypointAddress = await resolveEntrypointAddressForProvider(chainId);
  const poolKey = `${chainId}:${entrypointAddress.toLowerCase()}`;
  // Scope the SDK's proof-path ASP reads (root/leaves/labels/snapshot) to
  // this site's pool on multi-pool chains. Legacy mode pins its own routing
  // (mtId leaves, synthetic labels) and uses `httpClient` directly below, so
  // it neither needs nor should get the live-entrypoint scoping.
  const aspHttpClient: IHTTPClient = LEGACY_CONFIG
    ? httpClient
    : createEntrypointScopedHttpClient(httpClient, chainId, {
        // Only the SDK's full snapshot request shares this cache. Keep its own
        // parser and diagnostics, including coverage reductions for dropped rows.
        url: `${ASP_URL.replace(/\/$/, '')}/${chainId}/public/event-snapshot/payload?entrypoint=${entrypointAddress}`,
        load: () => loadPoolEventSnapshot(chainId, { entrypoint: entrypointAddress }),
      });
  // Only treat the env value as a usable fallback if it matches the
  // SDK's current 32-byte X25519 shape. A 33-byte secp256k1 value
  // (legacy) is silently ignored — it would just blow up later inside
  // cryptoService.ecdh with "must be 32 bytes, got 33".
  const envIsX25519 = !!ASP_PUBLIC_KEY && /^0x[0-9a-fA-F]{64}$/.test(String(ASP_PUBLIC_KEY));
  const configuredPublicKey = envIsX25519 ? (ASP_PUBLIC_KEY as PublicKey) : undefined;
  const providerConfig = {
    aspUrl: ASP_URL,
    chainId,
    entrypointAddress,
    httpClient: aspHttpClient,
  };
  const baseProvider = new HttpASPDataProvider(providerConfig);
  // Legacy spend-out build: when LEGACY_CONFIG is set, leaves MUST come
  // from the historical MT (e.g. id=305) so spend proofs verify against
  // the OLD pool. The base provider always hits the ASP's "current"
  // endpoint, which after the cutover points at the new pool. Bypass
  // and call the by-id leaves endpoint via httpClient. getRoot is NOT
  // overridden: the ASP does not expose /association-set/{id}/root, and
  // the SDK builds the witness root locally from leaves
  // (WitnessPreparationService sets associationSetRoot from aspProofs[0].root,
  // which is computed from the leaves we return here). The current/new
  // root returned by baseProvider in legacy mode is unused for proof
  // construction.
  const legacyLeavesUrl = LEGACY_CONFIG
    ? `${ASP_URL}/association-set/${LEGACY_CONFIG.mtId}/leaves`
    : undefined;
  const provider: IASPDataProvider = {
    async getRoot() {
      const root = LEGACY_CONFIG
        ? await baseProvider.getRoot()
        : await approvedLabelCache.root(baseProvider, chainId, poolKey);
      return normalizeHashString(root);
    },
    async getLeaves() {
      if (legacyLeavesUrl) {
        const data = await httpClient.get<{ leaves: string[] }>(legacyLeavesUrl);
        return data.leaves.map((leaf) => normalizeHashString(leaf));
      }
      // Cached and root-gated: EVERY leaf read in the app funnels through this
      // override (SDK internals included - the call stacks proved it), so this
      // is the one place that removes the repeated 525KB fetch. Order is
      // preserved because the SDK builds the association-set tree from this
      // list and leaf indices must not shift.
      const cached = await approvedLabelCache.leaves(baseProvider, chainId, poolKey);
      return cached as Hash[];
    },
    getLabelStatus: async (label: Hash) => {
      // Legacy mode: the ASP has wiped label-status for the old pool.
      // Treat every label as approved — membership in the pinned MT
      // (e.g. id=305) is itself proof of historical ASP approval at
      // deposit time. Without this override, the SDK would receive
      // 'unknown' for every legacy label, leave notes at PENDING, and
      // the withdraw UI's active-notes filter would block the sweep.
      if (LEGACY_CONFIG) {
        return { status: 'approved' as const };
      }
      // Newer decisions veto published membership. Both reads are pool-wide,
      // and the decisions one is now a pure read of the scheduled snapshot.
      const normalized = normalizeHashString(label);
      let decisions: { rejected: ReadonlySet<string>; poiRequired: ReadonlySet<string> };
      try {
        decisions = getPoolLabelDecisions(chainId);
      } catch {
        // The SDK Promise.all's this per unique label during discovery, so a
        // rejection here kills the whole sync. 'pending' is the fail-closed
        // answer: the SDK promotes to ACTIVE only on 'approved' and demotes
        // only on 'rejected', so an unknown decision set leaves the note
        // unspendable and demotes nothing.
        return { status: 'pending' as const };
      }
      const approved = await bulkApprovedLabels(baseProvider, chainId);
      if (decisions.rejected.has(normalized)) return { status: 'rejected' as const };
      if (decisions.poiRequired.has(normalized)) return { status: 'poi_required' as const };
      return { status: approved.has(normalized) ? 'approved' as const : 'pending' as const };
    },
    getEventSnapshot: () => {
      // Legacy mode: the ASP's event-snapshot serves the CURRENT pool's
      // events. Returning a snapshot of the new pool would misclassify
      // legacy notes (e.g. demote ACTIVE→PENDING from a non-matching
      // event scan). Fail closed so syncNotesStatusFromASP's try/catch
      // falls through to syncNotesStatusFromChain, which uses our
      // legacy-pinned PoolVault via RPC.
      if (LEGACY_CONFIG) {
        return Promise.reject(new Error('Legacy mode: ASP event-snapshot disabled; use chain RPC fallback.'));
      }
      // HTTP caching above preserves the SDK's parsing and row diagnostics.
      return baseProvider.getEventSnapshot();
    },
    // Discovery's Note events, read from the event snapshot the feed grid
    // holds (its `notes` section, services/snapshot-source.ts) rather than
    // fetched from /note-events. A discovery pass runs on the grid, at session
    // start, after an import and when the user presses sync, and each of those
    // used to put a request on the wire at that moment. The SDK sweeps the
    // chain over RPC above `lastSyncedBlock`, so an older copy costs a longer
    // tail, never a missed note. A copy that cannot be read throws, and the SDK
    // scans the whole requested range from the chain instead.
    // Legacy mode returns nothing so old pool events come from RPC against
    // the legacy-pinned PoolVault.
    getNoteEvents: async (fromBlock?: Hex, toBlock?: Hex) => {
      if (LEGACY_CONFIG) {
        return { events: [], lastSyncedBlock: '0x0' as Hex };
      }
      const held = await loadPoolEventSnapshot(chainId, { entrypoint: entrypointAddress });
      const coveredTo = snapshotCursor(held, ['notes']);
      if (coveredTo === null) throw new Error('held event snapshot carries no Note section');
      const from = fromBlock ? BigInt(fromBlock) : 0n;
      const to = toBlock ? BigInt(toBlock) : null;
      const events = noteEventsFromSnapshot(held.notes).filter((e) => {
        const block = BigInt(e.blockNumber);
        return block >= from && (to === null || block <= to);
      });
      // The block timestamps these rows carry, as hints for the note index
      // (see recordAspBlockTimestamps): only the range asked for.
      try {
        const inRange = new Set(events.map((e) => e.txHash.toLowerCase()));
        recordAspBlockTimestamps(chainId, held.notes.filter((row) => inRange.has(String(row.txHash).toLowerCase())));
      } catch {
        // Never let a diagnostics/cache path break discovery.
      }
      const tailFrom = coveredTo > SNAPSHOT_NOTE_OVERLAP_BLOCKS ? coveredTo - SNAPSHOT_NOTE_OVERLAP_BLOCKS : 0n;
      return { events: events as never, lastSyncedBlock: toHex(tailFrom) as Hex };
    },
    // The key the feed grid holds (services/public-asp-cache.ts). The SDK
    // asks for it while it prepares a deposit's ASP ciphertext, so a fetch
    // here was a request timed to the deposit. The configured key is the
    // fallback, as before.
    async getASPPublicKey() {
      const held = await heldAspPublicKey();
      if (held) return held as PublicKey;
      if (configuredPublicKey) return configuredPublicKey;
      throw new Error(
        'The ASP public key has not loaded yet. Try again in a moment.',
      );
    },
  };
  aspLeafPoolKeys.set(provider, poolKey);
  return provider;
}

// v2.0 migration: ASPClient now cross-checks every leaves fetch against the
// on-chain ASPRegistry `latestASPRoot` (trust anchor), so it needs a registry
// interactor. The registry address comes from chain config (env-overridable)
// with the SDK's DEPLOYMENTS constant as fallback.
function createASPRegistryInteractorFor(
  chainId: number,
  merkleService: IMerkleService,
  provider: IASPDataProvider,
): IASPRegistryInteractor {
  if (LEGACY_CONFIG) {
    // Legacy spend-out build: leaves come from a pinned historical MT whose
    // root will never match the CURRENT on-chain latestASPRoot. Anchor to
    // the pinned leaves themselves — membership in the frozen MT is itself
    // proof of historical ASP approval (same reasoning as the legacy
    // getLabelStatus override above), so the cross-check reduces to a
    // self-consistency check. Preserves pre-v2.0 behavior.
    const legacyRoot = async () => merkleService.computeRoot(await provider.getLeaves());
    return {
      getLatestASPRoot: () => legacyRoot(),
      getLatestAssociationSetData: async () => ({ root: await legacyRoot(), ipfsCID: '' }),
    };
  }
  const contracts = getChainConfig(chainId)?.contracts;
  const registryAddress = (contracts?.aspRegistryAddress ?? DEPLOYMENTS[chainId]?.aspRegistryAddress) as Address | undefined;
  if (!registryAddress) {
    throw new Error(`Missing ASP registry address for chain ${chainId}`);
  }
  return new ASPRegistryInteractor({
    rpcInteractor: createRPCInteractor(chainId),
    contractAddress: registryAddress,
  });
}

export async function createASPClient(
  chainId: number,
  merkleService: IMerkleService,
  dataProvider?: IASPDataProvider,
): Promise<IASPClient> {
  const provider = dataProvider ?? await createASPDataProvider(chainId);
  // Only inject ASP_PUBLIC_KEY into the SDK if the env value matches the
  // SDK's current pubkey shape (32-byte X25519). The deployed SDK moved
  // off secp256k1; a stale 33-byte compressed pubkey would short-circuit
  // /public-key but then blow up later inside cryptoService.ecdh with
  // "must be 32 bytes, got 33". When env is the wrong shape, skip it and
  // let the live /public-key endpoint provide the current key.
  const env = ASP_PUBLIC_KEY ? String(ASP_PUBLIC_KEY) : '';
  const publicKey = /^0x[0-9a-fA-F]{64}$/.test(env) ? (env as PublicKey) : undefined;
  const client = new ASPClient({
    providers: [provider],
    merkleService,
    aspRegistryInteractor: createASPRegistryInteractorFor(chainId, merkleService, provider),
    ...(publicKey ? { publicKey } : {}),
  });
  const poolKey = aspLeafPoolKeys.get(provider);
  if (!LEGACY_CONFIG && poolKey) {
    const verify = client.getAssociationSetLeaves.bind(client);
    client.getAssociationSetLeaves = () => approvedLabelCache.verify(chainId, poolKey, verify);
  }
  return client;
}

// ---------------------------------------------------------------------------
// Relayer interactor
// ---------------------------------------------------------------------------

export function createRelayerInteractor(
  chainId: number,
  // Default: the chain's TRANSFER-route processor (per-chain — staging
  // builds run several EVM chains with their own relayers).
  processorAddress: Address = getTransferProcessorAddress(chainId),
): IRelayerInteractor {
  const relayerBaseUrl = getChainConfig(chainId)?.relayerBaseUrl;
  if (!relayerBaseUrl) {
    throw new Error(`Missing relayerBaseUrl for chain ${chainId}`);
  }
  const httpClient = new FetchHTTPClient('relayer', relayerBaseUrl);
  // Every relay* result is a hash the RPC must never be asked about; record
  // them here so the RPC wrapper's waitForTransactionReceipt answers them from
  // bulk logs. services/relayed-receipt.ts.
  //
  // The same choke point keeps a relay of notes that are already in flight
  // from leaving at all, and records each new one until it settles
  // (services/pending-relays-core.ts).
  // Reservation id flows from beforeRelay to afterRelay/onRelayFailed for the
  // SAME call (recordRelayedHashes threads it through), so the owner it
  // reserved under — and the reservation itself — are exactly what this
  // relay started with, whatever the active account is by the time the
  // relayer answers (codex: switching accounts mid-relay must not tag the
  // pending record to the wrong one).
  const relayHooks: RelayHooks<string | null> = {
    beforeRelay: (_method: string, params: unknown) => {
      // A relayed transfer's proof must carry the outputs its flow planned and
      // stored before relaying (services/transfer-relay-outputs.ts). Every
      // caller of relayTransfer arms its plan with expectTransferRelay first;
      // an unplanned transfer is refused.
      checkTransferRelay(_method, params);
      const nullifiers = relayRequestNullifiers(params);
      assertNoPendingRelay(chainId, nullifiers);
      // Reserving right here — not only recording once the relayer answers —
      // closes the window where two concurrent sends of the same notes both
      // pass the check above before either has a hash to record.
      return reserveRelayNullifiers(chainId, _method, nullifiers);
    },
    afterRelay: (method: string, params: unknown, txHash: string, reservationId: string | null) =>
      commitRelayReservation(reservationId, { chainId, method, nullifiers: relayRequestNullifiers(params), txHash }),
    onRelayFailed: (_method: string, _params: unknown, _err: unknown, reservationId: string | null) =>
      releaseRelayReservation(reservationId),
  };
  return recordRelayedHashes(new RelayerInteractor({
    relayers: [
      {
        name: 'Fast Relay',
        url: relayerBaseUrl,
        chainId,
        chainType: 'evm',
        status: 'active',
        // Default: the TRANSFER-route record. The signer EOA *is* the
        // processor on that route (transfers call PoolVault.transact
        // directly, no PrivacyPoolRelay wrapper). The single-withdrawal route
        // rebinds the processor to the PrivacyPoolRelay contract per-call in
        // withdraw-modal-provider via rebindProcessor() (config/relayer.ts).
        //
        // The BATCH-withdrawal route can't rebind per-call — the SDK's
        // PoolSessionBatchWithdraw copies THIS record's processorAddress into
        // every batch proof's context, and on-chain relayBatch makes
        // msg.sender the PrivacyPoolRelay contract. So a batch session passes
        // `processorAddress = SEPOLIA_WITHDRAWAL_PROCESSOR_ADDRESS` here; the
        // shared main session keeps the transfer default untouched.
        address: getRelayerSignerAddress(chainId),
        processorAddress,
      },
    ],
    httpClient,
    addressSchema: AddressSchema,
  }), relayHooks);
}

/**
 * A relayer interactor that advertises NO relayers, for flows that provably
 * never relay: the disclosed ("Hide my address" off) transfer submits the
 * transact straight from the user's wallet.
 *
 * The SDK's `prepareTransfer` fetches transfer quotes unconditionally before
 * proving (`buildPrepareTransferResult` → `settleTransferRelayerQuotes`, with
 * `commit: true`), and `settleRelayerQuotes` THROWS `RelayerRequestFailed`
 * when every configured relayer fails. There is no parameter to skip it. So on
 * a chain the relayer does not serve, a disclosed self-submit — which needs no
 * relayer at all — died on a quote it would have discarded. The empty list is
 * the one documented way out: the throw is guarded by `relayers.length > 0`,
 * so no relayers means no request, no commitment reserved, and an empty
 * `relayOptions` the disclosed path never reads (it self-submits
 * `executeOptions.transactTx`).
 */
export function createRelayerlessInteractor(): IRelayerInteractor {
  // NOT `new RelayerInteractor({ relayers: [] })` — its config schema rejects an
  // empty list ("At least one relayer is required"), so that construction throws
  // before the session exists. A hand-rolled interactor is the only way to
  // present zero relayers. Every method other than the (empty) listing throws:
  // reaching one means a flow that was routed here tried to relay after all,
  // which must fail loudly rather than silently pick a relayer.
  const unreachable = (method: string) => async (): Promise<never> => {
    throw new Error(
      `${method} was called on the relayer-less session. This session exists only for flows that submit from the user's own wallet.`,
    );
  };
  // Typed, not cast: tsc is what guarantees the shape stays complete when the
  // SDK adds a method to the interface.
  const interactor: IRelayerInteractor = {
    getRelayers: async () => [],
    getTransferQuote: unreachable('getTransferQuote'),
    getWithdrawalQuote: unreachable('getWithdrawalQuote'),
    getBatchWithdrawalQuote: unreachable('getBatchWithdrawalQuote'),
    relayBatchWithdrawal: unreachable('relayBatchWithdrawal'),
    relayTransfer: unreachable('relayTransfer'),
    relayWithdrawal: unreachable('relayWithdrawal'),
    submitRelayedRegistration: unreachable('submitRelayedRegistration'),
    relayRegisterAndWithdrawal: unreachable('relayRegisterAndWithdrawal'),
    relayWithAnnounce: unreachable('relayWithAnnounce'),
    getSwapQuote: unreachable('getSwapQuote'),
    relaySwap: unreachable('relaySwap'),
    getChainDetails: unreachable('getChainDetails'),
  };
  return interactor;
}

// ---------------------------------------------------------------------------
// Contract interactors
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ASP-aware chunked RPC wrapper
//
// The SDK's PoolVaultInteractor / KeystoreInteractor build their state-tree
// witnesses by scanning chain history via eth_getLogs. With Alchemy capping
// each call at 9999 blocks and the V6 deploy block far back, that's 1–28
// sequential RPC calls per withdraw/transfer.
//
// The ASP already indexes the same logs (`onchain_leaf`, `keystore_event`).
// This wrapper:
//   1. Detects which event type the SDK is asking for (by event-name in
//      the ABI fragment + matching contract address).
//   2. If it's one we have an ASP endpoint for, fetches the bulk in a
//      single HTTP call.
//   3. Tops up the tail (blocks past the ASP's indexer cursor) from RPC.
//      The tail is bounded by indexer lag — typically a handful of blocks,
//      one chunk worst case. Indexer-down → falls all the way back to RPC.
//   4. Caches in memory across calls in the same session, keyed by
//      address + events ABI.
//
// Remove this whole wrapper if/when the SDK consumes the ASP fast path
// natively.
// ---------------------------------------------------------------------------

// Chunk sizing / cap-shrink logic lives in services/rpc-log-chunking.ts
// (pure module, unit-tested). Per-chain caps come from
// `ChainConfig.logsMaxBlockRange`; Citrea's public RPC allows only 1000.

// One window per CHAIN, not per interactor: createRPCInteractor is called ad
// hoc by the withdraw modal, audit receipts, transfer spendability and the
// payment-request flows, and a cap learned from a live provider error is
// worth keeping across all of them instead of each one re-paying an
// oversized window first.
const chainRangeWindows = new Map<number, RangeWindow>();

function rangeWindowForChain(chainId: number, configuredMax?: bigint): RangeWindow {
  const existing = chainRangeWindows.get(chainId);
  if (existing) return existing;
  const created = createRangeWindow(configuredMax);
  chainRangeWindows.set(chainId, created);
  return created;
}

type GetLogsParams = Parameters<IRPCInteractor['getLogs']>[0];
type GetLogsResult = Awaited<ReturnType<IRPCInteractor['getLogs']>>;
type DecodedLog = GetLogsResult[number];

type EventAbi = { type?: string; name?: string };

type AspKind = 'leaves' | 'keystore-leaves';

// One per CHAIN, like the range window: the pool's per-event reads come from
// different interactor instances and should still meet. Only sweep() uses it,
// which runs after the ASP decision in getLogs: LeavesInserted still goes to the
// ASP first, and only its RPC tail (blocks past the ASP's coverage) can share a
// call with the other pool events. See services/log-coalescer.ts.
const chainLogCoalescers = new Map<number, LogCoalescer<DecodedLog>>();

function logCoalescerForChain(chainId: number): LogCoalescer<DecodedLog> {
  const existing = chainLogCoalescers.get(chainId);
  if (existing) return existing;
  const created = createLogCoalescer<DecodedLog>({
    // Reuse a result for about one block, never longer than 12s.
    ttlMs: Math.min(Math.max(blockTimeMs(chainId), 1_000), 12_000),
  });
  chainLogCoalescers.set(chainId, created);
  return created;
}

// One chain head per chain for one block time, shared by every interactor.
// services/block-number-memo.ts.
const chainHeads = createBlockNumberMemo({ ttlMs: blockTimeMs });

// Map (poolAddress, keystoreAddress) → which ASP endpoint to use for a
// given event-fragment array. Returns null if the request doesn't match
// any ASP-served leaf event. Other events stay chain-derived because the
// note index uses them as independent evidence when repairing ASP timestamps.
function detectAspKind(
  params: GetLogsParams,
  poolAddress: string,
  keystoreAddress: string,
): AspKind | null {
  const events = (params.events ?? []) as EventAbi[];
  const names = new Set(
    events
      .filter((e) => e?.type === 'event' && typeof e.name === 'string')
      .map((e) => e.name!),
  );
  if (!params.address) return null;
  const addr = String(params.address).toLowerCase();
  if (addr === poolAddress.toLowerCase() && names.has('LeavesInserted')) {
    return 'leaves';
  }
  if (
    addr === keystoreAddress.toLowerCase() &&
    (names.has('LeafInserted') || names.has('LeafUpdated'))
  ) {
    return 'keystore-leaves';
  }
  return null;
}

function blockNumberHex(value: string): Hex {
  return ('0x' + BigInt(value).toString(16)) as Hex;
}

// Synthesise the same `DecodedEventLog` shape viem's decodeEventLog would
// emit, but built from a single ASP row. Each row corresponds to one
// individual leaf — we emit one fake `LeavesInserted` per leaf with
// `_newLeaves: [leaf]` and `_startIndex: leafIndex`. The SDK's consumer
// (`PoolVaultInteractor.getStateLeavesFromEvents`) places leaves by
// absolute index, so the fan-out is benign — `leaves[startIndex+0] = leaf`.
function synthLeavesInsertedLog(row: AspLeafRow): DecodedLog {
  return {
    eventName: 'LeavesInserted',
    args: {
      _newLeaves: [BigInt(row.leaf)],
      _root: BigInt(row.root),
      _startIndex: BigInt(row.leafIndex),
    },
    blockNumber: blockNumberHex(row.blockNumber),
    transactionHash: '0x' as Hex,
  } as DecodedLog;
}

function synthKeystoreLog(row: AspLeafRow): DecodedLog {
  const eventName = row.eventType === 'leaf_inserted' ? 'LeafInserted' : 'LeafUpdated';
  return {
    eventName,
    args: {
      _newLeaf: BigInt(row.leaf),
      _root: BigInt(row.root),
      _leafIndex: BigInt(row.leafIndex),
    },
    blockNumber: blockNumberHex(row.blockNumber),
    transactionHash: '0x' as Hex,
  } as DecodedLog;
}

// The pool note index each chain + pool last refreshed for a session read.
const latestPoolNoteIndexes = new Map<string, OnChainNoteIndex>();
const poolNoteIndexKey = (chainId: number, poolAddress: string) => `${chainId}:${poolAddress.toLowerCase()}`;

/**
 * The bulk note index the session's last pool read refreshed, for lookups only
 * (points spend times): reading it never issues a request. Null until a read
 * has built one.
 */
export function latestPoolNoteIndex(chainId: number, poolAddress: string): OnChainNoteIndex | null {
  const index = latestPoolNoteIndexes.get(poolNoteIndexKey(chainId, poolAddress));
  return index?.isBuilt() ? index : null;
}

class ChunkedRPCInteractor implements IRPCInteractor {
  private cache = new Map<string, { logs: GetLogsResult; firstBlock: bigint; lastBlock: bigint }>();

  // Inclusive block count per eth_getLogs call — see rangeWindowForChain:
  // shared per chain, not per interactor, so a cap learned once is not
  // re-learned by the next operation.
  private readonly rangeWindow: RangeWindow;

  constructor(
    private readonly inner: IRPCInteractor,
    private readonly deploymentBlock: bigint,
    private readonly chainId: number,
    private readonly poolAddress: string,
    private readonly keystoreAddress: string,
    maxBlockRange?: bigint,
    // Raw log scans for relayed receipts (see waitForTransactionReceipt). The
    // inner interactor's getLogs strips topics and data, which the SDK's
    // receipt-based nullifier check needs, so the policed viem client itself.
    private readonly rawClient?: RawLogClient,
  ) {
    this.rangeWindow = rangeWindowForChain(chainId, maxBlockRange);
  }

  // PRIVACY choke point. The vendored SDK still issues per-note reads from
  // inside note discovery (resolveCommitmentTimestamp for every decrypted note),
  // addNotes on the reshield path, and recoverRejectedNotes (spentNullifiers per
  // re-approved note). Every one of them arrives here as
  // readContract({ functionName: 'commitments' | 'spentNullifiers', args: [x] })
  // against the pool. They are answered from the bulk index and NEVER forwarded:
  // a value the index has not seen reads "not observed" (0), which the SDK
  // treats as unresolved and retries or leaves to the next discovery pass. The
  // earlier fall-through to the real read for an unseen value was the e2e
  // privacy gate's "RPC saw a commitment in the body", four times per transfer,
  // at the one moment the provider could link the fresh change note to this
  // client. Rule and answers: services/pool-read-router.ts. Removed when the
  // SDK tarball is rebuilt with its own OnChainNoteIndex; see SDK_PATCHES.md and
  // docs/privacy-request-discipline.md.
  private noteIndex: OnChainNoteIndex | null = null;
  private noteIndexBuild: Promise<OnChainNoteIndex> | null = null;
  // Catch-up for an unseen value. A discovery burst fans out hundreds of reads
  // for fresh notes; they all share one forced rebuild (in flight, or finished
  // within the debounce). The SDK's own retries for one note arrive 200-400ms
  // apart, so each of those gets a fresh look at the chain tail instead of the
  // stale answer a long window gave them.
  private forcedRefresh: Promise<void> | null = null;
  private lastForcedRefreshDoneMs = 0;
  private catchUp(index: OnChainNoteIndex): Promise<void> {
    if (this.forcedRefresh) return this.forcedRefresh;
    if (Date.now() - this.lastForcedRefreshDoneMs < 250) return Promise.resolve();
    this.forcedRefresh = index.refresh({ force: true }).finally(() => {
      this.lastForcedRefreshDoneMs = Date.now();
      this.forcedRefresh = null;
    });
    return this.forcedRefresh;
  }

  private poolNoteIndex(): Promise<OnChainNoteIndex> {
    if (this.noteIndex) return Promise.resolve(this.noteIndex);
    if (!this.noteIndexBuild) {
      this.noteIndexBuild = (async () => {
        const hashService = await createHashService();
        const vault = createPoolVaultInteractor(this, this.poolAddress as Address, hashService, this.deploymentBlock);
        const index = createOnChainNoteIndex({
          chainId: this.chainId,
          poolVaultInteractor: vault as never,
          hashService: hashService as never,
          poolAddress: this.poolAddress,
        });
        this.noteIndex = index;
        return index;
      })().finally(() => {
        this.noteIndexBuild = null;
      });
    }
    return this.noteIndexBuild;
  }

  async readContract(params: Parameters<IRPCInteractor['readContract']>[0]) {
    const pool = classifyPoolRead(params, this.poolAddress);
    // Not about a commitment or nullifier: the one read that may reach the RPC.
    if (!pool) return this.inner.readContract(params);

    const index = await this.poolNoteIndex();
    // refresh() is a no-op inside the staleness window and shares one build
    // between concurrent callers (discovery fans out hundreds of these).
    await index.refresh();
    latestPoolNoteIndexes.set(poolNoteIndexKey(this.chainId, this.poolAddress), index);
    // Seen: the index answers. Unseen: one catch-up, then the index answers or
    // the value reads "not observed". The value itself never leaves this client.
    return routePoolRead(index, pool, () => this.catchUp(index));
  }

  // Shared per chain for one block time (a new head cannot exist sooner).
  // Errors propagate unchanged and are not remembered.
  getBlockNumber(): Promise<Hex> {
    return this.head().then((head) => toHex(head) as Hex);
  }

  private head(): Promise<bigint> {
    return chainHeads.get(this.chainId, async () => BigInt(await this.inner.getBlockNumber()));
  }

  // A receipt proves its block exists: a scan right after the wait must reach
  // it even if the remembered head is older.
  private observeReceipt<R extends { blockNumber?: unknown }>(receipt: R): R {
    try {
      if (receipt?.blockNumber != null) chainHeads.observe(this.chainId, BigInt(receipt.blockNumber as string));
    } catch { /* not a block number: nothing to learn */ }
    return receipt;
  }

  // Forwarded ahead of the SDK bump that introduces it. This class enumerates
  // methods rather than delegating, which is exactly how getLogsPaginated went
  // missing and blew up withdraw at runtime (see the comment on
  // withDefaultFromBlock). Here the failure would be quieter and worse: the SDK
  // uses the finalized block to decide when a ragequit log is settled enough to
  // write a terminal EXITED, and a missing method degrades it to a confirmation
  // -depth guess with nothing visible to say so. The optional call keeps this
  // safe against an older vendored SDK whose inner interactor lacks it.
  getFinalizedBlockNumber(): Promise<FinalizedBlockResult> {
    const inner = this.inner as IRPCInteractor & {
      getFinalizedBlockNumber?: () => Promise<FinalizedBlockResult>;
    };
    // The SDK replaced `Hex | null` with a three-state result (audit stack, v2.0):
    // `null` conflated "this provider never serves the finalized tag" with "the
    // read failed just now", and the SDK treats those differently — the first is
    // a permanent property it can plan around, the second is worth retrying. An
    // inner interactor with no such method is the permanent case.
    return inner.getFinalizedBlockNumber?.() ?? Promise.resolve({ status: 'unsupported' });
  }

  waitForTransactionReceipt(hash: Parameters<IRPCInteractor['waitForTransactionReceipt']>[0]) {
    // PRIVACY. A RELAYED hash must not be polled on the RPC: the provider would
    // learn that this client is waiting on that relayed transaction, undoing
    // the relayer. The SDK's relay* paths hand the relayer's hash straight to
    // this method, so relayed hashes are recorded at the relayer interactor
    // (recordRelayedHashes) and answered here from bulk data: each new block's
    // transaction list says whether it mined, the pool's and keystore's logs for
    // that block say whether it succeeded, fetched by address and range only.
    // A hash this client broadcast itself is not relayed: the RPC already saw
    // it leave, and its receipt is the authoritative answer (revert included).
    // services/relayed-receipt.ts, docs/privacy-request-discipline.md.
    if (this.rawClient && isRelayedTxHash(hash)) {
      const raw = this.rawClient;
      // The wait's head reads share the chain's remembered head; its block and
      // log reads go to the raw client as before.
      const client: RawLogClient = {
        getBlockNumber: () => this.head(),
        getBlock: (args) => raw.getBlock(args),
        getLogs: (args) => raw.getLogs(args),
      };
      return waitForRelayedReceipt(hash as Hash, client, {
        addresses: [this.poolAddress as Hex, this.keystoreAddress as Hex],
      }).then((r) => {
        settlePendingRelayByReceipt(r.txHash, r.status);
        return this.observeReceipt(r);
      });
    }
    return this.inner.waitForTransactionReceipt(hash).then((r) => this.observeReceipt(r));
  }

  /**
   * The pool's leaves the feed grid holds (services/snapshot-source.ts), sliced
   * to [fromBlock, toBlock], with the block the copy covers through. Null on
   * any failure, and the caller falls through to plain RPC chunking.
   *
   * Never a request. The SDK rebuilds the state and keystore trees here while
   * it prepares every spend proof, so a fetch from this path would be an ASP
   * request timed to the spend. Whatever the copy lacks above its watermark,
   * the caller sweeps from RPC, so the tree is exact at the head however old
   * the copy is; an older copy costs a longer tail, never a lost leaf.
   */
  private async fetchFromASP(
    kind: AspKind,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<{ logs: GetLogsResult; lastBlock: bigint } | null> {
    try {
      const entrypoint = await resolveConfiguredEntrypoint(this.chainId);
      if (!entrypoint) return null;
      const held = await loadPoolLeaves(this.chainId, { entrypoint });
      const section = kind === 'leaves' ? held?.leaves : held?.keystoreLeaves;
      if (!Array.isArray(section)) return null;
      // A section watermark covers empty blocks, not just returned leaves.
      const coveredTo = snapshotCursor(held) ?? 0n;

      const logs: GetLogsResult = [];
      for (const row of section as AspLeafRow[]) {
        const blk = BigInt(row.blockNumber);
        if (blk > toBlock || blk < fromBlock) continue;
        logs.push(kind === 'leaves' ? synthLeavesInsertedLog(row) : synthKeystoreLog(row));
      }
      const lastBlock = coveredTo < fromBlock ? fromBlock - 1n : coveredTo < toBlock ? coveredTo : toBlock;
      return { logs, lastBlock };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[ASP] held leaves unavailable; falling back to RPC', err);
      return null;
    }
  }

  async getLogs(params: GetLogsParams): Promise<GetLogsResult> {
    const rawFrom = params.fromBlock != null ? BigInt(params.fromBlock) : 0n;
    // Snapped onto a shared grid so this client's exact sync cursor never
    // reaches the RPC provider. See services/log-scan-alignment.ts.
    const from = alignLogScanStart(rawFrom, this.deploymentBlock);

    let to: bigint;
    if (params.toBlock == null) {
      to = await this.head();
    } else {
      to = BigInt(params.toBlock);
    }

    const cacheKey = `${String(params.address ?? '').toLowerCase()}:${JSON.stringify(params.events ?? [])}`;
    const cached = this.cache.get(cacheKey);

    let startFrom = from;
    let firstBlock = from;
    let existingLogs: GetLogsResult = [];

    if (cached && cached.firstBlock <= from && cached.lastBlock >= from) {
      if (cached.lastBlock >= to) return cached.logs;
      firstBlock = cached.firstBlock;
      startFrom = cached.lastBlock + 1n;
      existingLogs = cached.logs;
    }

    // Legacy spend-out build: the ASP's event-snapshot endpoint serves
    // the CURRENT pool/keystore's logs. Routing legacy log scans through
    // it would synthesize current-pool leaves into spots where legacy
    // notes' state-leaf check expects OLD-pool leaves — and that hard
    // check then rejects every legacy note before withdrawal. Force RPC
    // in legacy mode.
    const aspKind = LEGACY_CONFIG
      ? null
      : detectAspKind(params, this.poolAddress, this.keystoreAddress);
    if (aspKind && startFrom <= to) {
      const aspResult = await this.fetchFromASP(aspKind, startFrom, to);
      if (aspResult) {
        // Only scan beyond the ASP section's indexed coverage.
        const tailLogs = await this.sweep(params, aspResult.lastBlock + 1n, to);
        const allLogs = [...existingLogs, ...aspResult.logs, ...tailLogs];
        this.cache.set(cacheKey, { logs: allLogs, firstBlock, lastBlock: to });
        return allLogs;
      }
      // ASP unreachable / 404 / malformed — fall through to chunked RPC.
    }

    // An empty range (startFrom > to) sweeps to [] without issuing a call.
    const newLogs = await this.sweep(params, startFrom, to);

    const allLogs = [...existingLogs, ...newLogs];
    this.cache.set(cacheKey, { logs: allLogs, firstBlock, lastBlock: to });
    return allLogs;
  }

  // Walks [from, to] in windows the chain's RPC accepts. Both the plain RPC
  // path and the ASP tail top-up go through here, so neither can outrun the
  // eth_getLogs cap — the tail is what blew up on Citrea (indexer ~3k blocks
  // behind head, cap 1000).
  //
  // The SDK's ViemRPCInteractor.getLogsPaginated does its own chunking,
  // bisecting and 429 backoff, but this wrapper deliberately calls the plain
  // getLogs — it owns the ASP fast path and the per-session cache, and it
  // needs to observe the cap error itself to remember the smaller window.
  // So window policy (including the 429 retry) lives in rpc-log-chunking.
  //
  // Each window goes through the chain's log coalescer: the pool's per-event
  // reads for the same window become one eth_getLogs with a topic0 OR-list,
  // and each caller still gets only its own events (services/log-coalescer.ts).
  // Windows, alignment and the per-key cache above are unchanged.
  private sweep(params: GetLogsParams, from: bigint, to: bigint): Promise<GetLogsResult> {
    if (from > to) return Promise.resolve([]);
    const coalescer = logCoalescerForChain(this.chainId);
    const address = typeof params.address === 'string' ? params.address : null;
    const events = (params.events ?? []) as EventAbi[];
    return sweepLogRange<DecodedLog>({
      // Cache extensions and ASP tails have their own cursors too. Align at
      // the wire boundary, then discard the overlap before merging the cache.
      from: alignLogScanStart(from, this.deploymentBlock),
      to,
      window: this.rangeWindow,
      fetch: (start, end) => {
        const plain = (evts: readonly unknown[]) =>
          this.inner.getLogs({ ...params, events: evts as any, fromBlock: start as any, toBlock: end as any });
        if (!address || events.length === 0) return plain(params.events as readonly unknown[]);
        return coalescer.fetch(address, events, start, end, plain);
      },
      onShrink: (span, next) => {
        console.warn(
          `[rpc] chain ${this.chainId}: eth_getLogs rejected a ${span}-block window. Chunking at ${next}`,
        );
      },
    }).then((logs) => logs.filter((log) => BigInt(log.blockNumber) >= from && BigInt(log.blockNumber) <= to));
  }

  // The SDK calls `getLogsPaginated(params)` for any historical sweep. Its
  // optional second argument (chunkSize) is ignored here on purpose: this
  // wrapper already chunks, caches and adapts the window inside `getLogs`,
  // so we just forward.
  async getLogsPaginated(params: GetLogsParams): Promise<GetLogsResult> {
    return this.getLogs(params);
  }
}

// ---------------------------------------------------------------------------

export function createRPCInteractor(chainId: number, deploymentBlock = 0): IRPCInteractor {
  const chain = getChainConfig(chainId);
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainId}`);
  }
  if (!chain.contracts) {
    throw new Error(`Missing contracts config for chain ${chainId}`);
  }
  // Built from an explicit PublicClient rather than ViemRPCInteractor.create,
  // ONLY so the transport can be the policed one. create() makes its own client
  // with a plain http transport, and this interactor is the SDK's whole window
  // onto the chain: note discovery, spend checks, receipt waits. The 2026-08-26
  // leak (108 per-nullifier eth_calls in one send) came out of exactly here and
  // was invisible in this repo's source, so it is the last place that should be
  // able to talk to an RPC provider unchecked.
  const publicClient = createPublicClient({
    chain: VIEM_CHAIN_BY_ID[chainId],
    transport: policedHttp(chain.rpcUrl),
    // viem caches getBlockNumber per client for cacheTime (default: its
    // polling interval, 4s). One block time is the longest a head can be
    // reused without missing a block; watchers (receipt waits) bypass it.
    cacheTime: blockTimeMs(chainId),
  });
  // TODO: Remove ChunkedRPCInteractor wrapper when SDK supports fromBlock/chunking natively.
  return new ChunkedRPCInteractor(
    new ViemRPCInteractor({ publicClient }),
    BigInt(deploymentBlock),
    chainId,
    chain.contracts.poolAddress,
    chain.contracts.keystoreAddress,
    chain.logsMaxBlockRange,
    publicClient as unknown as RawLogClient,
  );
}

export function createEntrypointInteractor(
  rpc: IRPCInteractor,
  entrypointAddress: Address,
): IEntrypointInteractor {
  return createEvmEntrypointInteractor({
    rpcInteractor: rpc,
    contractAddress: entrypointAddress,
  });
}

function withDefaultFromBlock(
  rpc: IRPCInteractor,
  defaultFromBlock?: bigint,
): IRPCInteractor {
  if (defaultFromBlock === undefined) {
    return rpc;
  }

  // Forward every method on the inner rpc, then override getLogs (and
  // getLogsPaginated for the newer SDK call sites) to inject the
  // default fromBlock when the SDK didn't pass one. The previous
  // implementation enumerated only a handful of methods, which silently
  // dropped getLogsPaginated and any future additions — withdraw blew
  // up at runtime with "this.rpcInteractor.getLogsPaginated is not a
  // function" because PoolVaultInteractor / KeystoreInteractor saw the
  // stripped object instead of the full ChunkedRPCInteractor.
  return new Proxy(rpc, {
    get(target, prop, receiver) {
      if (prop === 'getLogs') {
        return (params: Parameters<IRPCInteractor['getLogs']>[0]) =>
          target.getLogs({ ...params, fromBlock: params.fromBlock ?? defaultFromBlock });
      }
      if (prop === 'getLogsPaginated') {
        const inner = (target as IRPCInteractor & {
          getLogsPaginated?: IRPCInteractor['getLogsPaginated'];
        }).getLogsPaginated;
        if (typeof inner !== 'function') return undefined;
        // v2.0 migration: getLogsPaginated no longer takes a chunkSize hint —
        // the interactor owns its own pagination strategy.
        return (
          params: Parameters<IRPCInteractor['getLogsPaginated']>[0],
        ) =>
          inner.call(target, { ...params, fromBlock: params.fromBlock ?? defaultFromBlock });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function createPoolVaultInteractor(
  rpc: IRPCInteractor,
  poolAddress: Address,
  hashService?: IHashService,
  fromBlock?: bigint,
): IPoolVaultInteractor {
  void hashService;
  return createEvmPoolVaultInteractor(
    { rpcInteractor: withDefaultFromBlock(rpc, fromBlock), contractAddress: poolAddress },
  );
}

export function createKeystoreInteractor(
  rpc: IRPCInteractor,
  keystoreAddress: Address,
  fromBlock?: bigint,
): IKeystoreInteractor {
  return createEvmKeystoreInteractor({
    rpcInteractor: withDefaultFromBlock(rpc, fromBlock),
    contractAddress: keystoreAddress,
  });
}

// SDK workaround: reconcile the NoteManager state against the on-chain
// commitments in PoolVault. Handles three failure modes that all produce
// the same "Leaf <hash> not found in tree" witness error when trying to
// spend a note:
//
//   1. `Note.createdAtBlock` stored as a block number instead of the
//      on-chain `block.timestamp`. Pre-a97f6ef `PoolSessionNoteDiscovery`
//      wrote `log.blockNumber` there. Block numbers are still well below
//      1e9; Unix timestamps have been above it since 2001 — anything in
//      `(0, 1e9)` is a stale block number.
//   2. `createdAtBlock: 0x0` placeholders. `PoolSessionTransact.addOutputNotes`
//      inserts every change note with `createdAtBlock: "0x0"` because the
//      tx hasn't been mined yet when `prepareTransfer` adds it locally. If
//      the tx DOES confirm later, we just need to pull the real timestamp
//      back in.
//   3. Phantom output notes. Same `addOutputNotes` path — but the tx never
//      confirms (MetaMask rejects, user cancels, reverts, whatever). The
//      optimistic change note is now stuck in NoteManager pointing at a
//      commitment that is NOT on-chain, blocking any future spend of its
//      (actually-still-unspent) parent input note.
//
// Cases 1 and 2 are healed in-place by replacing createdAtBlock with
// `PoolVault.commitmentTimestamp(commitment)`. Case 3 is detected by a
// zero timestamp AND a `createdAtBlock` that looks unset (< threshold):
// the commitment simply isn't on-chain, so we drop the note from the
// manager entirely. Genuine just-mined deposits still show up on the next
// reload (`discoverNotes` re-adds them with the correct timestamp), so
// dropping a too-new note is self-healing.
//
// Returns `{ healed, removed }`.
export async function healNoteTimestamps(
  noteManager: INoteManager,
  // Was `IPoolVaultInteractor`, and read `commitments(c)` once per stored note.
  // That enumerated the user's entire portfolio to the RPC provider on every
  // session init. The index answers the same question from bulk data — the
  // "always consult the chain" reasoning below is preserved, only the channel
  // changed. See services/onchain-note-index.ts.
  noteIndex: OnChainNoteIndex,
): Promise<{ healed: number; removed: number }> {
  const BLOCK_VS_TIMESTAMP_THRESHOLD = 1_000_000_000n;
  const stored = noteManager.exportState() as unknown as {
    notes: Array<{ commitment: Hash; createdAtBlock: Hex; txHash?: Hex; [k: string]: unknown }>;
    syncCursor?: Hex;
    [k: string]: unknown;
  };
  if (!stored?.notes?.length) return { healed: 0, removed: 0 };

  let healed = 0;
  const resolved = await Promise.all(
    stored.notes.map(async (note) => {
      try {
        const current = BigInt(note.createdAtBlock ?? '0x0');
        // Always consult the chain — a stored value in the valid timestamp
        // range (>= 1e9) can still be *wrong* (off by a few seconds from a
        // prior RPC, or from a reorg). Using it would make the state-tree
        // leaf `Poseidon(commitment, createdAtBlock)` mismatch the on-chain
        // leaf, and the witness passes pre-checks but the circuit reverts
        // with `inputMerkleProofs[i].out === stateRoot` (Transact_300:186).
        if (!noteIndex.isBuilt()) await noteIndex.refresh();
        const realTsRaw = noteIndex.commitmentTimestamp(note.commitment);
        const realTs = realTsRaw ? BigInt(realTsRaw) : 0n;
        if (realTs > 0n) {
          // On-chain: ensure the stored timestamp matches exactly. Overwrite
          // if it drifts.
          if (current !== realTs) {
            healed += 1;
            return { note: { ...note, createdAtBlock: realTsRaw as Hex }, keep: true };
          }
          return { note, keep: true };
        }
        // Not on-chain.
        if (current >= BLOCK_VS_TIMESTAMP_THRESHOLD) {
          // Already a valid-looking timestamp but the commitment isn't
          // indexed yet (fresh just-submitted note or snapshot lag). Keep.
          return { note, keep: true };
        }
        // If createdAtBlock is 0 AND txHash is the SDK's pre-submit
        // placeholder (`0x0`), this is a phantom from an optimistic
        // `addOutputNotes` whose tx never confirmed. Drop it.
        // `commitmentTimestamp` returning null covers two cases: genuinely
        // absent, and on-chain but timestamp-unverifiable. Only the first may
        // lead to deletion, so consult presence explicitly before dropping.
        if (noteIndex.hasCommitment(note.commitment)) {
          return { note, keep: true };
        }
        const isPhantom = current === 0n && (!note.txHash || /^0x0*$/i.test(note.txHash));
        if (isPhantom) {
          return { note, keep: false };
        }
        return { note, keep: true };
      } catch {
        return { note, keep: true };
      }
    }),
  );

  const keptNotes = resolved.filter((r) => r.keep).map((r) => r.note);
  const removed = stored.notes.length - keptNotes.length;

  if (healed > 0 || removed > 0) {
    (noteManager as unknown as { importState: (s: unknown) => void }).importState({
      ...stored,
      notes: keptNotes,
    });
  }
  return { healed, removed };
}

// ---------------------------------------------------------------------------
// Contract address discovery via the Entrypoint contract
// ---------------------------------------------------------------------------

const ENTRYPOINT_KEYSTORE_ABI = [
  {
    type: 'function' as const,
    name: 'KEYSTORE' as const,
    inputs: [] as readonly [],
    outputs: [{ name: 'keystore_', type: 'address' as const }] as const,
    stateMutability: 'view' as const,
  },
] as const;

export async function readKeystoreAddress(
  rpc: IRPCInteractor,
  entrypointAddress: Address,
): Promise<Address> {
  const result = await rpc.readContract({
    address: entrypointAddress,
    abi: ENTRYPOINT_KEYSTORE_ABI,
    functionName: 'KEYSTORE',
  });
  if (typeof result !== 'string' || !isAddress(result)) {
    throw new Error(
      `readKeystoreAddress: unexpected RPC return type (${typeof result}), expected address`,
    );
  }
  return result as Address;
}

/**
 * Whether the vendored SDK can exit a note whose local status is already EXITED.
 *
 * Needed because the two halves of the ASP-reported-exit fix ship separately.
 * `prepareRageQuit` refuses an EXITED note before it builds the witness, and
 * `rageQuit` just calls `prepareRageQuit` — so against an SDK without the
 * `allowUnconfirmedExit` opt-in, every such note the client surfaces is a button
 * that throws. A dead end with an error is worse than the note being absent,
 * because the user now believes recovery was attempted and failed.
 *
 * Probed rather than assumed: the SDK arrives as a vendored tarball and moves
 * independently of this repo, so a version constant here would be a second thing
 * to remember to update. When the tarball is refreshed the exit list lights up
 * with no further change.
 *
 * Reads `SDK_FEATURES`, which exists for exactly this. The obvious probe — look
 * at `RageQuitParamsSchema.shape` — does not work and fails in the quiet
 * direction: the SDK hand-curates its runtime exports in `src/external.ts`, so
 * schemas and most error classes are absent from the bundle even though
 * `index.d.ts` advertises them. That name resolves to `undefined` against EVERY
 * build, old or new, so the feature would have stayed dark forever while
 * typechecking perfectly.
 *
 * Returns false on any failure — an absent or unreadable flag is not evidence of
 * support.
 */
export async function sdkAllowsUnconfirmedExit(): Promise<boolean> {
  try {
    const sdk = (await import('@privacy-pools-v2/sdk')) as unknown as {
      SDK_FEATURES?: { allowUnconfirmedExit?: boolean };
    };
    return sdk.SDK_FEATURES?.allowUnconfirmedExit === true;
  } catch {
    return false;
  }
}

/**
 * Whether the vendored SDK knows the provisional `EXIT_PENDING` note status.
 *
 * This gate is not cosmetic. `NoteManager.updateNoteStatus` validates against
 * `VALID_STATUS_TRANSITIONS`, and an older bundle has no `EXIT_PENDING` entry —
 * so writing it there throws `InvalidStatusTransitionError`. That happens on the
 * path where the ragequit has ALREADY succeeded on chain, so the user would be
 * told their exit failed while their funds were in fact out. Strictly worse than
 * the bug the provisional state exists to fix.
 *
 * Returns false on any failure, which is exactly what an older build looks like.
 */
export async function sdkSupportsProvisionalExit(): Promise<boolean> {
  try {
    const sdk = (await import('@privacy-pools-v2/sdk')) as unknown as {
      SDK_FEATURES?: { provisionalExitStatus?: boolean };
    };
    return sdk.SDK_FEATURES?.provisionalExitStatus === true;
  } catch {
    return false;
  }
}
