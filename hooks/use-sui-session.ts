/**
 * Sui session orchestration — the missing glue between the UI modals and the
 * Sui hook stack. Where `usePoolSession` (EVM) wraps the EVM SDK, this hook
 * wraps the Sui pieces (`usePrivacyPool` -> use-sui-*, the witness service, the
 * note store, the chain reader) into one call per flow that a modal can invoke
 * directly under the `useChainRouter().isSui` branch.
 *
 * Responsibilities:
 *   - Derive the account's keys deterministically from a Sui wallet signature
 *     (nullifying / revocable / viewing), mirroring the EVM seed-derivation.
 *   - Register the keystore auth policy + viewing key on first use (the &Clock
 *     arg is now threaded by use-sui-keystore).
 *   - DEPOSIT: derive note secrets, build the native deposit witness, prove,
 *     submit through the entrypoint, and PERSIST the note (owner-namespaced) so
 *     it is recoverable (a successful Sui deposit otherwise returns only a
 *     digest and the note is lost).
 *
 * SPEND flows: WITHDRAW / TRANSFER reconstruct live state/keystore/ASP Merkle
 * proofs from chain events via `prepareSpendInputs` below, then build the
 * transact witness + proof. RAGEQUIT is keystore-only — it exits a note
 * directly with no state/ASP proof, so it reconstructs just the keystore proof
 * (not `prepareSpendInputs`). The modal wiring routes each flow to Sui under the
 * `useChainRouter().isSui` branch.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCurrentAccount, useSignAndExecuteTransaction, useSignPersonalMessage, useSuiClient } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { keccak256 } from 'js-sha3';
import { usePrivacyPool } from '@/hooks/use-privacy-pool';
import { useSuiKeystore } from '@/hooks/use-sui-keystore';
import { useSuiNotes } from '@/hooks/use-sui-notes';
import { SuiChainReader } from '@/services/sui-witness/chain-reader';
import {
  addressToU256,
  addressToBytes32,
  encodePayoutRouting,
  calculateNullifyingKeyHash,
  computeAuthDigestDirectKey,
  randomFieldElement,
  generateEncryptionRandomness,
  reconstructStateProofs,
  reconstructKeystoreProof,
  reconstructAspProofs,
  type SpendNote,
} from '@/services/sui-witness';
import {
  computeExpectedKeystoreLeaf,
  reconstructAspProofsFromLeaves,
  waitForKeystoreLeaf,
  type AspReconstruction,
} from '@/services/sui-witness/reconstruct';
import type { MerkleProof } from '@/services/sui-witness/merkle';
import { deriveViewingPublicKey } from '@/services/sui-witness/note-crypto';
import { loadSuiNotes, upsertSuiNote, type StoredSuiNote } from '@/services/sui-witness/note-store';
import { SUI_TESTNET_GVK } from '@/config/sui-deployment';
import { suiAccountSupportsApp } from '@/config/chains';
import { fetchSuiApprovedSet } from '@/services/sui-witness/asp-labels';
import {
  appendRegisterLabelCall,
  approvedLabelSubset,
  buildAspLabelCiphertext,
} from '@/services/sui-witness/asp-registration';

const DEFAULT_COIN_TYPE = '0x2::sui::SUI';

/** Domain-separated seed message the wallet signs once per account. */
const SEED_MESSAGE = 'privacy-pools/sui/account-seed:v2';

/** Deterministic account keys derived from a Sui wallet signature. */
interface DerivedKeys {
  /** Field-element nullifying key (circuit `privateNullifyingKey`). */
  privateNullifyingKey: bigint;
  /** Field-element revocable key (circuit `privateRevocableKey`). */
  privateRevocableKey: bigint;
  /** secp256k1 viewing private key (0x-hex) for the off-chain note channel. */
  viewingPrivateKeyHex: string;
  /** Compressed secp256k1 viewing public key (0x-hex). */
  viewingPublicKeyHex: string;
}

const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** keccak256(domainByte || hex) -> bigint, reduced into the BN254 scalar field. */
function deriveField(domain: string, hex: string): bigint {
  const h = keccak256(domain + hex);
  return BigInt('0x' + h) % SNARK_SCALAR_FIELD;
}

/**
 * Random tokenId < 2^160. The deposit circuit enforces tokenId < 2^160
 * (Num2Bits(160), matching EVM address-width token ids); 20 random bytes is
 * always < 2^160. Matches the live-deposit-smoke convention.
 */
function randomTokenId(): bigint {
  const bytes = new Uint8Array(20);
  globalThis.crypto.getRandomValues(bytes);
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/** 0x-hex encode bytes (browser-safe; matches the live relay e2e `hex()`). */
function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return '0x' + s;
}

function deriveKeysFromSignature(signatureBytes: Uint8Array): DerivedKeys {
  let hex = '';
  for (const b of signatureBytes) hex += b.toString(16).padStart(2, '0');
  const privateNullifyingKey = deriveField('01', hex);
  const privateRevocableKey = deriveField('02', hex);
  // 32-byte secp256k1 viewing private key from a third domain.
  const vpkHex = keccak256('03' + hex);
  const viewingPrivateKeyHex = '0x' + vpkHex;
  const viewingPublicKeyHex = deriveViewingPublicKey(viewingPrivateKeyHex);
  return {
    privateNullifyingKey,
    privateRevocableKey,
    viewingPrivateKeyHex,
    viewingPublicKeyHex,
  };
}

export interface SuiDepositResult {
  txDigest: string;
  commitment: bigint;
  label: bigint;
}

// One label-registration sweep attempt per address per page load (the session
// hook has several always-mounted consumers; the sweep must not run per-instance).
const sweptAddresses = new Set<string>();

export function useSuiSession() {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  const { mutateAsync: signAndExecuteTransaction } = useSignAndExecuteTransaction();
  const privacyPool = usePrivacyPool();
  const keystore = useSuiKeystore();
  const suiNotes = useSuiNotes();

  // Cache derived keys + keystore-registered state per account address.
  const keysRef = useRef<{ address: string; keys: DerivedKeys } | null>(null);
  // Account address whose keys have been derived this session, so the
  // auto-discovery effect can run once keys exist (without forcing a signature).
  const [keysReadyAddr, setKeysReadyAddr] = useState<string | null>(null);
  // Account addresses we've already run note-discovery for (once per account; a
  // Set so switching A→B→A doesn't re-trigger A's auto-discovery).
  const discoveredRef = useRef<Set<string>>(new Set());

  /**
   * Guard every state-changing flow against a Sui wallet that can't transact on
   * the app's network. Sui submits go through dapp-kit's
   * `useSignAndExecuteTransaction`, which signs for the app's configured network
   * (testnet — the only enabled Sui deployment). A connected account whose
   * Wallet-Standard `chains` capability list lacks `sui:testnet` cannot sign for
   * it, so refuse to build/submit early with a clear message instead of failing
   * deep in the wallet. Fails closed (unknown/empty/mainnet-only => blocked).
   * Read-only flows (discovery) are not gated; they simply find nothing.
   */
  const assertSupportedNetwork = useCallback(() => {
    if (!suiAccountSupportsApp(account?.chains)) {
      throw new Error(
        'Connected Sui wallet cannot sign for the app network (Sui Testnet). Add/enable Sui Testnet in your wallet and try again.',
      );
    }
  }, [account]);

  /** Sign (once per account) and derive the account keys. */
  const ensureKeys = useCallback(async (): Promise<DerivedKeys> => {
    const address = account?.address;
    if (!address) throw new Error('Sui wallet not connected');
    if (keysRef.current && keysRef.current.address === address) {
      return keysRef.current.keys;
    }
    const { signature } = await signPersonalMessage({
      message: new TextEncoder().encode(SEED_MESSAGE),
    });
    // dapp-kit returns the signature base64-encoded; decode to bytes for the seed.
    const sigBytes =
      typeof signature === 'string'
        ? Uint8Array.from(
            (typeof atob === 'function' ? atob(signature) : ''),
            (c) => c.charCodeAt(0),
          )
        : (signature as Uint8Array);
    const keys = deriveKeysFromSignature(sigBytes);
    keysRef.current = { address, keys };
    setKeysReadyAddr(address);
    return keys;
  }, [account, signPersonalMessage]);

  /**
   * Register the keystore auth policy (and optionally publish the viewing key)
   * for the connected account if not already registered on-chain. Idempotent:
   * if the policy is already set the contract aborts E_AUTH_POLICY_ALREADY_SET,
   * which we treat as "already registered" and continue.
   *
   * `requireLeaf` makes the registration LOAD-BEARING: after submitting, wait
   * until the leaf is visible in the reconstructed event stream, and throw if it
   * never appears. The spend paths need this — they reconstruct the keystore
   * proof immediately afterwards, and queryEvents indexing lags finality, so
   * proceeding straight away would surface the cryptic "spender keystore leaf
   * not found" even after a successful registration.
   *
   * `publishViewingKey` (default true, the historical deposit behavior) sends
   * the set_viewing_key tx for the recipient note channel. Spend paths pass
   * false: the viewing key is not needed to SPEND, and set_viewing_key is a
   * real signed transaction — leaving it on would add a surprise wallet prompt
   * + gas to every transfer/withdraw/ragequit, even for registered accounts.
   */
  const ensureKeystoreRegistered = useCallback(
    async (options?: { requireLeaf?: boolean; publishViewingKey?: boolean }) => {
    assertSupportedNetwork();
    const contracts = privacyPool.suiContracts;
    if (!contracts) throw new Error('Sui contracts not configured for active chain');
    const address = account?.address;
    if (!address) throw new Error('Sui wallet not connected');
    const keys = await ensureKeys();

    const authDigest = await computeAuthDigestDirectKey(keys.privateRevocableKey);
    const nullifyingKeyHash = await calculateNullifyingKeyHash(keys.privateNullifyingKey);
    // Same helper the reconstruction uses, so probe/wait can never drift from
    // the leaf reconstructKeystoreProof will look for.
    const expectedLeaf = await computeExpectedKeystoreLeaf(
      addressToU256(address),
      keys.privateNullifyingKey,
      keys.privateRevocableKey,
    );
    const reader = new SuiChainReader({
      client,
      packageId: contracts.packageId,
      poolId: contracts.poolObjectId,
      keystoreId: contracts.keystoreObjectId,
    });

    // Probe whether this account's keystore leaf is already on-chain. If it is,
    // skip set_auth_policy: re-submitting it aborts with E_AUTH_POLICY_ALREADY_SET
    // (70), which the Sui wallet surfaces as a scary "Unable to process
    // transaction" warning on the deposit confirmation screen even though the
    // deposit succeeds. On probe failure (RPC), assume unregistered and attempt
    // it (the already-set abort is still tolerated below).
    let alreadyRegistered = false;
    try {
      const leaves = await reader.reconstructKeystoreLeaves();
      alreadyRegistered = leaves.includes(expectedLeaf);
    } catch (err) {
      console.warn('[sui] keystore registration probe failed; attempting set_auth_policy', err);
    }

    if (!alreadyRegistered) {
      try {
        await keystore.setAuthPolicy({
          packageId: contracts.packageId,
          keystoreObjectId: contracts.keystoreObjectId,
          authDigest,
          nullifyingKeyHash,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // E_AUTH_POLICY_ALREADY_SET (70) => already registered (a stale probe
        // raced a prior registration; the leaf exists) — not fatal. Everything
        // else (rejected signature, out of gas, RPC failure) propagates NOW,
        // with the real error, instead of timing out in the leaf wait below.
        if (!/already|70\b/i.test(msg)) throw err;
      }

      // Spend paths reconstruct the keystore proof right after this returns, so
      // the leaf must actually be indexed by then. Reached only after a
      // successful submit or a tolerated abort-70 (leaf already on-chain), so
      // the wait converges quickly; its deadline guards indexing outages.
      if (options?.requireLeaf) {
        await waitForKeystoreLeaf(reader, expectedLeaf);
      }
    }

    // Publish the current viewing key (recipient channel). Kept even for
    // already-registered accounts so one whose auth policy was set by an older
    // build (or whose earlier viewing-key write failed) still gets it published;
    // this call is idempotent and does not abort-on-set, so it raises no warning.
    if (options?.publishViewingKey !== false) {
      try {
        const viewingKeyField = deriveField('04', keys.viewingPublicKeyHex.slice(2));
        await keystore.setViewingKey({
          packageId: contracts.packageId,
          keystoreObjectId: contracts.keystoreObjectId,
          viewingKey: viewingKeyField,
        });
      } catch (err) {
        console.warn('[sui] set_viewing_key failed (non-fatal)', err);
      }
    }
  }, [privacyPool, keystore, ensureKeys, assertSupportedNetwork, account, client]);

  /**
   * Register any stored deposit notes whose labels never reached the ASP —
   * deposits made before register_label joined the deposit PTB (or whose
   * ciphertext build failed) otherwise sit "pending" forever. One attempt per
   * address per page load; labels already in the association set are just
   * marked. One PTB covers all missing labels (single wallet signature).
   */
  useEffect(() => {
    const address = account?.address;
    const contracts = privacyPool.suiContracts;
    if (!address || !contracts) return;
    if (!suiAccountSupportsApp(account?.chains)) return;
    if (sweptAddresses.has(address)) return;
    sweptAddresses.add(address);

    const timer = setTimeout(async () => {
      try {
        const notes = loadSuiNotes(address).filter(
          (n) => n.label && n.depositSecret && n.status === 'active' && !n.aspRegistered,
        );
        if (notes.length === 0) return;
        const byLabel = new Map(notes.map((n) => [n.label, n]));
        const labels = Array.from(byLabel.keys()).map((l) => BigInt(l));
        const approved = await approvedLabelSubset(labels);
        if (approved === null) return; // can't verify. Don't register blindly
        const missing = labels.filter((l) => !approved.has(l));
        for (const l of labels) {
          if (approved.has(l)) {
            const n = byLabel.get(l.toString());
            if (n) upsertSuiNote(address, { ...n, aspRegistered: true });
          }
        }
        if (missing.length === 0) return;
        const tx = new Transaction();
        for (const l of missing) {
          const n = byLabel.get(l.toString())!;
          const ciphertext = await buildAspLabelCiphertext({
            ownerAddress: BigInt(n.ownerAddress),
            noteSecret: BigInt(n.noteSecret),
            tokenId: BigInt(n.tokenId),
            value: BigInt(n.value),
            depositSecret: BigInt(n.depositSecret!),
          });
          appendRegisterLabelCall(tx, {
            packageId: contracts.packageId,
            aspRegistryObjectId: contracts.aspRegistryObjectId,
            ciphertext,
          });
        }
        await signAndExecuteTransaction({ transaction: tx });
        for (const l of missing) {
          const n = byLabel.get(l.toString());
          if (n) upsertSuiNote(address, { ...n, aspRegistered: true });
        }
        console.info(`[sui] registered ${missing.length} deposit label(s) with the ASP`);
      } catch (err) {
        console.warn('[sui] ASP label registration sweep failed (will retry next load)', err);
      }
    }, 8000);
    return () => clearTimeout(timer);
  }, [account, privacyPool.suiContracts, signAndExecuteTransaction]);

  /**
   * Full Sui deposit: derive note secrets, build the native deposit witness +
   * proof, submit through the entrypoint, and persist the note for recovery.
   */
  const deposit = useCallback(
    async (params: { amount: bigint; coinType?: string; shouldContinue?: () => boolean }): Promise<SuiDepositResult> => {
      const address = account?.address;
      if (!address) throw new Error('Sui wallet not connected');
      assertSupportedNetwork();
      const contracts = privacyPool.suiContracts;
      if (!contracts) throw new Error('Sui contracts not configured for active chain');

      const coinType = params.coinType ?? DEFAULT_COIN_TYPE;
      const keys = await ensureKeys();
      await ensureKeystoreRegistered();

      const ownerAddress = addressToU256(address);
      const noteSecret = randomFieldElement();
      const depositSecret = randomFieldElement();
      // tokenId is a depositor-chosen value (< 2^160, enforced by the deposit
      // circuit's Num2Bits(160)) that the pool maps to the coin type `T` on
      // first deposit (TokenTypeKey -> type_name). There is no canonical SUI
      // tokenId on this deployment (the live smoke script uses a random one per
      // deposit), so generate a fresh < 2^160 id per deposit. This matches the
      // authoritative live-deposit-smoke pattern and avoids E_TOKEN_TYPE_MISMATCH
      // against a tokenId another type already registered.
      const tokenId = randomTokenId();

      // Build witness -> proof -> PTB args (native deposit circuit).
      const prep = await privacyPool.prepareDepositTx({
        value: params.amount,
        tokenId,
        noteSecret,
        depositSecret,
        ownerAddress,
      });

      // Encrypt the note payload for the ASP so register_label can join the
      // deposit PTB. Best-effort: if the ASP public key is unreachable the
      // deposit still goes through and the post-connect sweep registers later.
      let registerLabelCiphertext: number[] | undefined;
      try {
        registerLabelCiphertext = await buildAspLabelCiphertext({
          ownerAddress,
          noteSecret,
          tokenId,
          value: params.amount,
          depositSecret,
        });
      } catch (err) {
        console.warn('[sui] ASP label ciphertext build failed; will register after deposit', err);
      }

      // Last pre-prompt gate (codex): key derivation/registration/proving above
      // can outlive the caller's modal — never pop the wallet for a superseded run.
      if (params.shouldContinue && !params.shouldContinue()) throw new Error('Superseded: the operation was cancelled before submission. Nothing was sent.');
      const result = await privacyPool.deposit({
        amount: prep.amount,
        proofBytes: prep.proofBytes,
        outputCommitment: prep.outputCommitment,
        tokenId: prep.tokenId,
        noteHint: prep.noteHint,
        noteData: prep.noteData,
        registerLabelCiphertext,
      });
      if (!result) throw new Error('Sui deposit submission failed');

      // Persist the note (owner-namespaced) so it is recoverable.
      upsertSuiNote(address, {
        commitment: prep.outputCommitment.toString(),
        value: params.amount.toString(),
        tokenId: tokenId.toString(),
        label: prep.label.toString(),
        noteSecret: noteSecret.toString(),
        depositSecret: depositSecret.toString(),
        ownerAddress: ownerAddress.toString(),
        coinType,
        status: 'active',
        txDigest: result.txDigest,
        aspRegistered: registerLabelCiphertext !== undefined,
      });
      suiNotes.refetch();

      return { txDigest: result.txDigest, commitment: prep.outputCommitment, label: prep.label };
    },
    [account, privacyPool, ensureKeys, ensureKeystoreRegistered, suiNotes, assertSupportedNetwork],
  );

  /** Build the chain reader for the active deployment. */
  const buildReader = useCallback(() => {
    const contracts = privacyPool.suiContracts;
    if (!contracts) throw new Error('Sui contracts not configured for active chain');
    return new SuiChainReader({
      client,
      packageId: contracts.packageId,
      poolId: contracts.poolObjectId,
      keystoreId: contracts.keystoreObjectId,
      aspRegistryId: contracts.aspRegistryObjectId,
    });
  }, [privacyPool, client]);

  /** Map a persisted note into the reconstruction's SpendNote shape. */
  const toSpendNote = useCallback((n: StoredSuiNote): SpendNote => ({
    value: BigInt(n.value),
    tokenId: BigInt(n.tokenId),
    label: BigInt(n.label),
    noteSecret: BigInt(n.noteSecret),
    ownerAddress: BigInt(n.ownerAddress),
  }), []);

  /**
   * Assemble the live inputs required to SPEND existing notes (transfer /
   * withdraw; ragequit is keystore-only and does NOT use this): the
   * reconstructed state/keystore/ASP Merkle proofs,
   * the verified roots, the live GVK state, and the spender's keys. This ports
   * the proven-live reference flow (live-relay-withdraw-e2e STEPs 2-4) into the
   * browser. The caller then builds the transact witness + proof.
   *
   * `inputNotes` are the persisted notes to spend. For the ASP proof, the
   * approved-label set (the operator-published set whose root the postman pushed
   * on-chain — the browser cannot push an ASP root itself, PostmanCap) is
   * resolved in priority order: (1) an explicit `approvedLabels` arg, else
   * (2) the configured ASP source `EXPO_PUBLIC_SUI_ASP_LABELS_URL` (via
   * fetchSuiApprovedLabels), else (3) the input notes' OWN labels as a fallback.
   * The fallback only validates when the on-chain ASP root commits to exactly
   * that set; otherwise reconstruction fails loudly (label not yet approved).
   */
  const prepareSpendInputs = useCallback(
    async (params: { inputNotes: StoredSuiNote[]; approvedLabels?: bigint[] }) => {
      const keys = await ensureKeys();
      const address = account?.address;
      if (!address) throw new Error('Sui wallet not connected');
      const reader = buildReader();

      const inputNotes = params.inputNotes;
      if (inputNotes.length < 1) throw new Error('at least one input note is required');
      const spendNotes = inputNotes.map(toSpendNote);
      const ownerAddress = addressToU256(address);

      // The spender's keystore leaf must exist on-chain before the keystore
      // reconstruction below. Deposits register it, but an account whose only
      // interaction is RECEIVING a note (OOB import / payment link) has never
      // deposited — spending from it must register here or it dies with
      // "spender keystore leaf not found on-chain" (QA: transfer B->A after an
      // OOB transfer A->B). Idempotent: registered accounts skip the tx.
      await ensureKeystoreRegistered({ requireLeaf: true, publishViewingKey: false });

      // Live GVK state: binds the witness to pool.gvk (E_GVK_MISMATCH) + selects
      // the GVK vs plain wrapper (E_INVALID_CIPHERTEXT). Default true on read
      // failure (the contract default), matching the SDK.
      let gvkEnabled = true;
      let gvk: [bigint, bigint] = [SUI_TESTNET_GVK.x, SUI_TESTNET_GVK.y];
      try {
        gvkEnabled = await reader.getGvkEnabled();
        if (gvkEnabled) {
          const onchain = await reader.getPoolGvk();
          gvk = [onchain.x, onchain.y];
        }
      } catch {
        // keep defaults (static GVK, enabled)
      }

      // STATE: reconstruct + verify against the pool root_buffer.
      const state = await reconstructStateProofs(reader, spendNotes);

      // KEYSTORE: reconstruct + cross-check against current_root.
      const keystore = await reconstructKeystoreProof(
        reader,
        ownerAddress,
        keys.privateNullifyingKey,
        keys.privateRevocableKey,
      );

      // ASP: prove each note's labelHash against the latest on-chain ASP root.
      // Source the approved set in priority order: an explicit caller arg
      // (label preimages), then the operator-published set
      // (EXPO_PUBLIC_SUI_ASP_LABELS_URL — either label preimages or the 0xBow
      // ASP's pre-hashed association-set leaves), then the input notes' OWN
      // labels as a fallback — valid only when the on-chain root commits to
      // exactly that set (the self-pushed testnet case). Reconstruction fails
      // loudly on any root mismatch (label not yet ASP-approved).
      let asp: AspReconstruction;
      if (params.approvedLabels) {
        asp = await reconstructAspProofs(reader, spendNotes, params.approvedLabels);
      } else {
        const aspSet = await fetchSuiApprovedSet();
        if (aspSet === null) {
          asp = await reconstructAspProofs(reader, spendNotes, spendNotes.map((n) => n.label));
        } else if (aspSet.kind === 'leaves') {
          asp = await reconstructAspProofsFromLeaves(reader, spendNotes, aspSet.values);
        } else {
          asp = await reconstructAspProofs(reader, spendNotes, aspSet.values);
        }
      }

      return {
        gvkEnabled,
        gvk,
        ownerAddress,
        keys,
        stateRoot: state.stateRoot,
        keystoreRoot: keystore.keystoreRoot,
        aspRoot: asp.aspRoot,
        stateMerkleProofs: state.proofs as MerkleProof[],
        keystoreMerkleProof: keystore.proof,
        aspMerkleProofs: asp.proofs as MerkleProof[],
        timestamps: state.timestamps,
        spendNotes,
      };
    },
    [account, buildReader, ensureKeys, ensureKeystoreRegistered, toSpendNote],
  );

  /**
   * Transfer or withdraw: reconstruct proofs, build the SuiTransact witness +
   * proof, and submit `pool::transact` (transfer, amountOut == 0) or
   * `pool::transact_withdraw` (withdraw, amountOut > 0) DIRECTLY (non-relayed;
   * processor @0x0 so any sender may submit). The output note(s) are returned
   * so the caller can persist them. Mirrors the live e2e direct-submit path.
   *
   * @param params.inputNotes notes to spend (persisted StoredSuiNote).
   * @param params.outputNotes change/transfer outputs (raw field params).
   * @param params.amountOut gross withdrawal (0 => pure transfer).
   * @param params.tokenIdOut withdrawal token id (ignored when amountOut == 0).
   * @param params.coinType Move coin type for a withdrawal (default SUI).
   * @param params.approvedLabels operator-published ASP label set (optional).
   */
  const transferOrWithdraw = useCallback(
    async (params: {
      inputNotes: StoredSuiNote[];
      outputNotes: {
        value: bigint;
        tokenId: bigint;
        label: bigint;
        noteSecret: bigint;
        ownerAddress: bigint;
      }[];
      amountOut: bigint;
      tokenIdOut: bigint;
      coinType?: string;
      approvedLabels?: bigint[];
      shouldContinue?: () => boolean;
    }): Promise<{ txDigest: string; outputCommitments: bigint[]; nullifierHashes: bigint[] }> => {
      const address = account?.address;
      if (!address) throw new Error('Sui wallet not connected');
      assertSupportedNetwork();
      const prep = await prepareSpendInputs({
        inputNotes: params.inputNotes,
        approvedLabels: params.approvedLabels,
      });

      // Stamp each input note's reconstructed insertion timestamp into the
      // witness input notes (the circuit recomputes the timestamped leaf).
      const witnessInputNotes = prep.spendNotes.map((n, i) => ({
        ...n,
        timestamp: prep.timestamps[i],
        leafIndex: prep.stateMerkleProofs[i].index,
      }));

      const tx = await privacyPool.prepareTransactTx(
        {
          inputNotes: witnessInputNotes,
          outputNotes: params.outputNotes,
          ownerAddress: prep.ownerAddress,
          privateNullifyingKey: prep.keys.privateNullifyingKey,
          privateRevocableKey: prep.keys.privateRevocableKey,
          amountOut: params.amountOut,
          tokenIdOut: params.tokenIdOut,
          stateRoot: prep.stateRoot,
          keystoreRoot: prep.keystoreRoot,
          aspRoot: prep.aspRoot,
          stateMerkleProofs: prep.stateMerkleProofs,
          keystoreMerkleProof: prep.keystoreMerkleProof,
          aspMerkleProofs: prep.aspMerkleProofs,
          gvkEnabled: prep.gvkEnabled,
          gvk: prep.gvk,
          encryptionRandomness: generateEncryptionRandomness(),
          processorBytes: new Uint8Array(32),
          processorData: new Uint8Array(0),
          noteHints: [],
          noteData: [],
        },
        // processor @0x0 => any sender may submit (direct, non-relayed).
        { processor: '0x0000000000000000000000000000000000000000000000000000000000000000' },
      );

      // Last pre-prompt gate (codex) — see deposit().
      if (params.shouldContinue && !params.shouldContinue()) throw new Error('Superseded: the operation was cancelled before submission. Nothing was sent.');
      let txDigest: string | null;
      if (params.amountOut === 0n) {
        txDigest = await privacyPool.transact(tx);
      } else {
        txDigest = await privacyPool.transactWithdraw({
          ...tx,
          coinType: params.coinType ?? DEFAULT_COIN_TYPE,
        });
      }
      if (!txDigest) throw new Error('Sui transact submission failed');

      // Mark inputs spent + persist OWN outputs for recovery. Outputs owned by
      // someone else (transfer recipients) must NOT enter this wallet's store —
      // they aren't our balance; the recipient imports them via the receipt.
      const { markSuiNotesSpent } = await import('@/services/sui-witness/note-store');
      const { addressToU256: toField } = await import('@/services/sui-witness');
      const selfField = toField(address);
      markSuiNotesSpent(address, params.inputNotes.map((n) => n.commitment));
      for (let j = 0; j < params.outputNotes.length; j++) {
        const o = params.outputNotes[j];
        if (o.ownerAddress !== selfField) continue;
        upsertSuiNote(address, {
          commitment: tx.outputCommitments[j].toString(),
          value: o.value.toString(),
          tokenId: o.tokenId.toString(),
          label: o.label.toString(),
          noteSecret: o.noteSecret.toString(),
          ownerAddress: o.ownerAddress.toString(),
          coinType: params.coinType ?? DEFAULT_COIN_TYPE,
          status: 'active',
          txDigest,
        });
      }
      suiNotes.refetch();

      return { txDigest, outputCommitments: tx.outputCommitments, nullifierHashes: tx.nullifierHashes };
    },
    [account, privacyPool, prepareSpendInputs, suiNotes, assertSupportedNetwork],
  );

  /**
   * RELAYED withdraw: the gas-abstracted path. Unlike `transferOrWithdraw` (which
   * binds the DIRECT context — processor @0x0, empty processor_data — and submits
   * the PTB itself), this binds the RELAYER context into the proof and hands the
   * proof to the relayer to submit:
   *
   *   processor      = the relayer's signer address (from `/v1/details`)
   *   processor_data = encodePayoutRouting(recipient, feeRecipient, feeAmount)
   *   context        = keccak256(relayerAddr32 || lenPrefix(payoutRouting72)) % field
   *
   * The relayer's on-chain `relay::relay_withdrawal` recomputes the identical
   * context from `ctx.sender()` (itself) + the same payout data, so the proof's
   * context matches (else the pool aborts E_INVALID_PROOF). The fee is bound into
   * the routing, so the relayer cannot redirect the payout or inflate the fee.
   *
   * Steps mirror the proven-live reference (sdk RelayWithdrawBuilder +
   * scripts/live-relay-withdraw-e2e.mjs):
   *   1. read `/v1/details` (relayer signer + fee receiver)
   *   2. fetch + VALIDATE a quote (fails CLOSED on a bad/stale quote)
   *   3. bind processor=relayer + processor_data=payout routing into the proof
   *   4. POST `/v1/relay/withdrawal`
   *
   * @param params.amountOut gross withdrawal (> 0).
   * @param params.recipient final withdrawal recipient (0x-hex Sui address).
   * @param params.relayerUrl base URL of the relayer.
   * @param params.maxFeeAmount optional caller cap on the relay fee.
   */
  const relayedWithdraw = useCallback(
    async (params: {
      inputNotes: StoredSuiNote[];
      outputNotes: {
        value: bigint;
        tokenId: bigint;
        label: bigint;
        noteSecret: bigint;
        ownerAddress: bigint;
      }[];
      amountOut: bigint;
      tokenIdOut: bigint;
      recipient: string;
      relayerUrl: string;
      coinType?: string;
      approvedLabels?: bigint[];
      maxFeeAmount?: bigint;
      shouldContinue?: () => boolean;
    }): Promise<{ txDigest: string; feeAmount: bigint; amountReceived: bigint }> => {
      const address = account?.address;
      if (!address) throw new Error('Sui wallet not connected');
      assertSupportedNetwork();
      if (params.amountOut <= 0n) throw new Error('relayed withdraw requires amountOut > 0');
      const coinType = params.coinType ?? DEFAULT_COIN_TYPE;

      // 1. Relayer self-description: the signer (processor) + fee receiver.
      const details = await privacyPool.getRelayDetails(params.relayerUrl);
      if (!details) throw new Error('relayer /v1/details unavailable');
      const relayerAddress = details.relayerAddress;
      const feeRecipient = details.feeRecipient ?? relayerAddress;
      if (!relayerAddress) throw new Error('relayer did not report a relayerAddress');

      // 2. Quote + validate (fails CLOSED on a bad/stale quote, before proving).
      const validated = await privacyPool.getRelayQuote({
        relayerUrl: params.relayerUrl,
        asset: coinType,
        amount: params.amountOut.toString(),
        maxFeeAmount: params.maxFeeAmount,
      });
      if (!validated) throw new Error('relayer quote validation failed');
      const feeAmount = validated.feeAmount;

      // 3. Reconstruct spend inputs + bind the RELAYER context.
      const prep = await prepareSpendInputs({
        inputNotes: params.inputNotes,
        approvedLabels: params.approvedLabels,
      });
      const witnessInputNotes = prep.spendNotes.map((n, i) => ({
        ...n,
        timestamp: prep.timestamps[i],
        leafIndex: prep.stateMerkleProofs[i].index,
      }));

      // processor = relayer signer; processor_data = the 72-byte payout routing.
      const processorBytes = addressToBytes32(relayerAddress);
      const processorData = encodePayoutRouting(params.recipient, feeRecipient, feeAmount);

      const tx = await privacyPool.prepareTransactTx(
        {
          inputNotes: witnessInputNotes,
          outputNotes: params.outputNotes,
          ownerAddress: prep.ownerAddress,
          privateNullifyingKey: prep.keys.privateNullifyingKey,
          privateRevocableKey: prep.keys.privateRevocableKey,
          amountOut: params.amountOut,
          tokenIdOut: params.tokenIdOut,
          stateRoot: prep.stateRoot,
          keystoreRoot: prep.keystoreRoot,
          aspRoot: prep.aspRoot,
          stateMerkleProofs: prep.stateMerkleProofs,
          keystoreMerkleProof: prep.keystoreMerkleProof,
          aspMerkleProofs: prep.aspMerkleProofs,
          gvkEnabled: prep.gvkEnabled,
          gvk: prep.gvk,
          encryptionRandomness: generateEncryptionRandomness(),
          // The witness context MUST bind the relayer + payout routing.
          processorBytes,
          processorData,
          noteHints: [],
          noteData: [],
        },
        // The on-chain PTB sender (the relayer) MUST equal processorBytes.
        { processor: relayerAddress },
      );

      // 4. Hand the context-bound proof to the relayer.
      // Last pre-submission gate (codex) — see deposit().
      if (params.shouldContinue && !params.shouldContinue()) throw new Error('Superseded: the operation was cancelled before submission. Nothing was sent.');
      const relayResult = await privacyPool.submitRelay({
        relayerUrl: params.relayerUrl,
        proofBytes: bytesToHex(tx.proofBytes),
        n: tx.n,
        m: tx.m,
        nullifierHashes: tx.nullifierHashes.map((h) => h.toString()),
        outputCommitments: tx.outputCommitments.map((c) => c.toString()),
        stateRoot: prep.stateRoot.toString(),
        keystoreRoot: prep.keystoreRoot.toString(),
        aspRoot: prep.aspRoot.toString(),
        amountOut: params.amountOut.toString(),
        tokenIdOut: tx.tokenIdOut.toString(),
        gvkX: tx.gvkX.toString(),
        gvkY: tx.gvkY.toString(),
        ciphertext: tx.ciphertext.map((c) => c.toString()),
        coinType,
        recipient: params.recipient,
        feeAmount: feeAmount.toString(),
        noteHints: [],
        noteData: [],
        feeCommitment: validated.commitment,
      });
      if (!relayResult) throw new Error('relayer submission failed');
      // Belt-and-braces: submitRelay already rejects success bodies without a
      // digest, but the local note store must never mutate off a bad one.
      if (typeof relayResult.txDigest !== 'string' || relayResult.txDigest.length === 0) {
        throw new Error('relayer returned no transaction digest');
      }

      // 5. Confirm the digest actually landed (and succeeded) BEFORE mutating
      //    the local note store — a lying/malformed relayer must not mark our
      //    inputs spent for a transaction that never executed.
      let confirmedTx;
      try {
        confirmedTx = await client.waitForTransaction({
          digest: relayResult.txDigest,
          options: { showEffects: true },
        });
      } catch (err) {
        throw new Error(
          `relayed withdrawal not confirmed on-chain (digest ${relayResult.txDigest}): `
          + (err instanceof Error ? err.message : String(err)),
        );
      }
      const execStatus = confirmedTx.effects?.status;
      if (execStatus?.status !== 'success') {
        throw new Error(
          `relayed withdrawal ${relayResult.txDigest} failed on-chain`
          + (execStatus?.error ? `: ${execStatus.error}` : ''),
        );
      }

      // Mark inputs spent + persist outputs for recovery.
      const { markSuiNotesSpent } = await import('@/services/sui-witness/note-store');
      markSuiNotesSpent(address, params.inputNotes.map((n) => n.commitment));
      for (let j = 0; j < params.outputNotes.length; j++) {
        const o = params.outputNotes[j];
        upsertSuiNote(address, {
          commitment: tx.outputCommitments[j].toString(),
          value: o.value.toString(),
          tokenId: o.tokenId.toString(),
          label: o.label.toString(),
          noteSecret: o.noteSecret.toString(),
          ownerAddress: o.ownerAddress.toString(),
          coinType,
          status: 'active',
          txDigest: relayResult.txDigest,
        });
      }
      suiNotes.refetch();

      return {
        txDigest: relayResult.txDigest,
        feeAmount,
        amountReceived: BigInt(relayResult.amountReceived),
      };
    },
    [account, privacyPool, prepareSpendInputs, suiNotes, assertSupportedNetwork, client],
  );

  /**
   * Ragequit: emergency exit of a single note (no ASP/state proof needed — the
   * ragequit circuit only proves keystore membership + note ownership and
   * exposes the label). Reconstructs the keystore proof, builds the native
   * ragequit witness + proof, and submits `pool::ragequit`.
   */
  const ragequit = useCallback(
    async (params: {
      note: StoredSuiNote;
      coinType?: string;
      shouldContinue?: () => boolean;
    }): Promise<{ txDigest: string; nullifierHash: bigint }> => {
      const address = account?.address;
      if (!address) throw new Error('Sui wallet not connected');
      assertSupportedNetwork();
      const keys = await ensureKeys();
      const reader = buildReader();
      const ownerAddress = addressToU256(address);

      // Same registration requirement as the transfer/withdraw path: a
      // received-note-only account has no keystore leaf and the reconstruction
      // below fails without it. Idempotent for registered accounts.
      await ensureKeystoreRegistered({ requireLeaf: true, publishViewingKey: false });

      const keystore = await reconstructKeystoreProof(
        reader,
        ownerAddress,
        keys.privateNullifyingKey,
        keys.privateRevocableKey,
      );

      const note = toSpendNote(params.note);
      const tx = await privacyPool.prepareRagequitTx(
        {
          note,
          keystoreRoot: keystore.keystoreRoot,
          ownerAddress,
          keystoreMerkleProof: keystore.proof,
          privateNullifyingKey: keys.privateNullifyingKey,
          privateRevocableKey: keys.privateRevocableKey,
        },
        address,
      );

      // Last pre-prompt gate (codex) — see deposit().
      if (params.shouldContinue && !params.shouldContinue()) throw new Error('Superseded: the operation was cancelled before submission. Nothing was sent.');
      const txDigest = await privacyPool.ragequit({ ...tx, coinType: params.coinType ?? DEFAULT_COIN_TYPE });
      if (!txDigest) throw new Error('Sui ragequit submission failed');

      const { markSuiNotesSpent } = await import('@/services/sui-witness/note-store');
      markSuiNotesSpent(address, [params.note.commitment]);
      suiNotes.refetch();

      return { txDigest, nullifierHash: tx.nullifierHash };
    },
    [account, privacyPool, buildReader, ensureKeys, ensureKeystoreRegistered, toSpendNote, suiNotes, assertSupportedNetwork],
  );

  /**
   * Explicit "scan / refresh": derive keys (prompting a signature if not yet
   * cached) and run on-chain note discovery (ECDH trial-decrypt) so received
   * notes + own outputs are merged into the local store. Safe to wire to a
   * refresh button.
   */
  const scanForNotes = useCallback(async () => {
    const keys = await ensureKeys();
    if (account?.address) discoveredRef.current.add(account.address);
    return suiNotes.discover(keys.viewingPrivateKeyHex);
  }, [ensureKeys, account, suiNotes]);

  // Auto-discovery: once keys have been derived for the connected account (via
  // any signed action — registration, deposit, transact), run discovery ONCE so
  // received notes surface without a manual scan. This only fires AFTER keys
  // already exist, so it never prompts a signature on bare connect.
  useEffect(() => {
    const addr = account?.address;
    if (!addr || keysReadyAddr !== addr || discoveredRef.current.has(addr)) return;
    const cached = keysRef.current;
    if (!cached || cached.address !== addr) return;
    discoveredRef.current.add(addr); // mark before await to avoid concurrent dupes
    suiNotes.discover(cached.keys.viewingPrivateKeyHex).catch(() => {
      /* error surfaced via suiNotes.discoverError; manual scanForNotes can retry */
    });
  }, [account?.address, keysReadyAddr, suiNotes]);

  return {
    account,
    ensureKeys,
    ensureKeystoreRegistered,
    deposit,
    prepareSpendInputs,
    transferOrWithdraw,
    relayedWithdraw,
    ragequit,
    scanForNotes,
    loadNotes: useCallback(() => (account?.address ? loadSuiNotes(account.address) : []), [account]),
    notes: suiNotes,
    status: privacyPool.status,
    proofStatus: privacyPool.proofStatus,
  };
}
