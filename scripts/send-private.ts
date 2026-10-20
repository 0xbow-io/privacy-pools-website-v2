/**
 * Standalone private-transfer script — browser-equivalent flow, run from Node.
 *
 *   bun run scripts/send-private.ts
 *
 * Reads the depositor's private key from `.env` (`DEV_PK`),
 * derives the SDK seed deterministically (same EIP-712 typed-data sig
 * the web app uses via wagmi), spins up a PoolSession against Sepolia
 * v5 contracts, discovers notes, picks one ACTIVE note with value ≥ the
 * transfer amount, and submits a *discoverable* transfer via the SDK's
 * HTTPS relayer to `0x6A7DafCB5483Da70F5eDee1481A29C2004Cc3c81`.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Load .env into process.env BEFORE importing anything that reads env at
// module-load time (services/sdk-setup reads ASP_URL / RPC URL / etc).
const ENV_PATH = join(__dirname, '..', '.env');
for (const line of readFileSync(ENV_PATH, 'utf8').split(/\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
  if (m) process.env[m[1]] = (process.env[m[1]] as string | undefined) ?? m[2].replace(/^["']|["']$/g, '');
}

import {
  createPublicClient,
  http,
  parseAbi,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';

// Intercept fetch so we can see the relayer's error body (the SDK's
// HTTPResponseError drops the body on the floor).
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input: any, init?: any) => {
  const res = await originalFetch(input, init);
  const url = typeof input === 'string' ? input : input?.url;
  if (typeof url === 'string' && url.includes('/relay/') && !res.ok) {
    const body = await res.clone().text();
    console.log(`[relayer ${res.status}] ${url}`);
    console.log('  response body:', body);
  }
  return res;
};

import {
  createCryptoService,
  createHashService,
  createMerkleService,
  createWitnessService,
  createProofService,
  createASPClient,
  createRelayerInteractor,
  createRPCInteractor,
  createEntrypointInteractor,
  createPoolVaultInteractor,
  createKeystoreInteractor,
  buildSecretDerivationPayload,
  createKeystoreManagerFromSignature,
  createNoteManager,
  healNoteTimestamps,
} from '../services/sdk-setup';
import { expectTransferRelay } from '../services/transfer-relay-outputs';
import { SEPOLIA_TRANSFER_PROCESSOR_ADDRESS } from '../config/relayer';
import { createEvmPoolSession, NoteComputationService, type EvmPoolSessionConfig, type Note } from '@privacy-pools-v2/sdk';

// ---------------------------------------------------------------------------
// Config — mirrors CLAUDE.md + config/chains.ts
// ---------------------------------------------------------------------------

const ARTIFACTS_DIR = join(__dirname, '..', 'public', 'artifacts');

const CHAIN_ID = 11155111; // Sepolia
// Match the current SDK deployments registry on Sepolia (see
// v2-monorepo packages/sdk/src/constant/deployments.ts). The old V5
// addresses (0x25C6…, 0x8f4d…, 0x903c…) are obsolete after the
// Curve25519 / cold-start-transfer refactor.
const ENTRYPOINT = '0x8445493038708311e55a526587d6ec4338377df0' as Hex;
const POOL_VAULT = '0xc131a029e8096fd427c2c2fd489b77c80b21574a' as Hex;
const KEYSTORE = '0xbb52626b05aad8950c6e90397aef3c3cab7d9ed1' as Hex;
const ETH_ASSET = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Hex;
const RECIPIENT = '0x6A7DafCB5483Da70F5eDee1481A29C2004Cc3c81' as Hex;
const TRANSFER_AMOUNT_WEI = 1_200_000_000_000_000n; // 0.0012 ETH
const FROM_BLOCK = 10523005n;

// ---------------------------------------------------------------------------
// EIP-712 seed-derivation — SDK canonical HKDF scheme (mirrors sdk-provider.tsx).
// ---------------------------------------------------------------------------

// Circuit artifacts served via the file system.
function createLocalCircuitArtifacts() {
  return {
    async getWasm(circuitName: string): Promise<Uint8Array> {
      const path = join(ARTIFACTS_DIR, circuitName, `${circuitName}_js`, `${circuitName}.wasm`);
      if (!existsSync(path)) throw new Error(`Missing wasm: ${path}`);
      return new Uint8Array(readFileSync(path));
    },
    async getProvingKey(circuitName: string): Promise<Uint8Array> {
      const path = join(ARTIFACTS_DIR, circuitName, 'groth16_pkey.zkey');
      if (!existsSync(path)) throw new Error(`Missing zkey: ${path}`);
      return new Uint8Array(readFileSync(path));
    },
    async getVerificationKey(circuitName: string): Promise<Uint8Array> {
      const path = join(ARTIFACTS_DIR, circuitName, 'groth16_vkey.json');
      if (!existsSync(path)) throw new Error(`Missing vkey: ${path}`);
      return new Uint8Array(readFileSync(path));
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const pk = (process.env.DEV_PK || '').trim();
  if (!pk) throw new Error('DEV_PK missing from .env (renamed from EXPO_PUBLIC_DEV_PK — the EXPO_PUBLIC_ prefix on a private key risks bundle inlining)');
  const pkHex = (pk.startsWith('0x') ? pk : `0x${pk}`) as Hex;
  const account = privateKeyToAccount(pkHex);
  console.log('Sender address:', account.address);

  // ── Derive SDK seed (canonical HKDF) ────────────────────────────
  const payload = buildSecretDerivationPayload(account.address as Hex);
  const sig = (await account.signTypedData({
    domain: payload.domain,
    types: payload.types,
    primaryType: payload.primaryType,
    message: payload.message,
  })) as Hex;

  // ── Wire all SDK services via ppv2's existing factories ─────────
  const cryptoService = createCryptoService();
  const hashService = await createHashService();
  const merkleService = createMerkleService(hashService);
  const witnessService = createWitnessService(hashService, merkleService, cryptoService);
  const proofService = createProofService(createLocalCircuitArtifacts() as any);
  const aspClient = await createASPClient(CHAIN_ID, merkleService);
  const relayerInteractor = createRelayerInteractor(CHAIN_ID);
  const rpc = createRPCInteractor(CHAIN_ID, Number(FROM_BLOCK));
  const entrypointInteractor = createEntrypointInteractor(rpc, ENTRYPOINT);
  const poolVaultInteractor = createPoolVaultInteractor(rpc, POOL_VAULT, hashService, FROM_BLOCK);
  const keystoreInteractor = createKeystoreInteractor(rpc, KEYSTORE, FROM_BLOCK);

  const keystoreManager = createKeystoreManagerFromSignature({
    signature: sig,
    signerAddress: account.address as `0x${string}`,
    addressHash: payload.message.addressHash,
    revocableKeyIndex: '0x0' as Hex,
  });
  console.log('Viewing pubkey:', keystoreManager.getViewingKeyPair().publicKey);
  const noteManager = createNoteManager();
  const noteComputationService = new NoteComputationService({ hashService, cryptoService });

  // Upstream's PoolSessionConfig dropped explicit `poolAddress` — the
  // session derives it from `poolVaultInteractor.getAddress()`.
  const session = createEvmPoolSession({
    ownerAddress: account.address as `0x${string}`,
    chainId: CHAIN_ID,
    cryptoService,
    merkleService,
    noteComputationService,
    witnessPreparationService: witnessService,
    proofService,
    entrypointInteractor,
    noteManager,
    keystoreManager,
    keystoreInteractor,
    hashService,
    poolVaultInteractor,
    aspClient,
    aspDataProvider: (aspClient as any)['providers']?.[0],
    rpcInteractor: rpc,
    relayerInteractor,
  } satisfies EvmPoolSessionConfig);
  console.log('PoolSession ready.');

  // ── Discover notes ──────────────────────────────────────────────
  console.log('Discovering notes (scanning chain)…');
  const discovered = await session.discoverNotes();
  console.log(`Discovered ${discovered.length} note(s) this pass.`);

  // Repair stale createdAtBlock values (placeholder 0x0 on change notes,
  // block-number leftovers from old discoveries). Without this the witness
  // builder computes Poseidon(commitment, wrong-ts) which doesn't match
  // any on-chain leaf — "Leaf not found in tree".
  const { createOnChainNoteIndex } = await import('@/services/onchain-note-index');
  const noteIndex = createOnChainNoteIndex({
    chainId: CHAIN_ID,
    poolVaultInteractor: poolVaultInteractor as never,
    hashService: hashService as never,
  });
  const heal = await healNoteTimestamps(noteManager as any, noteIndex);
  if (heal.healed > 0 || heal.removed > 0) {
    console.log(`Healed ${heal.healed} timestamps, removed ${heal.removed} phantom notes.`);
  }

  const all = (noteManager as any).getNotes() as Note[];
  console.log(`NoteManager has ${all.length} notes total.`);

  // Cross-check nullifiers against bulk chain data.
  //
  // This block used to read PoolVault.spentNullifiers(n) per note, justified by
  // a claim that the ASP snapshot's decimal nullifierHashes never match the
  // SDK's hex-keyed map. That claim is FALSE for the vendored SDK: snapshot
  // fields go through DecimalRepresentationToHexSchema -> bigintToHex, which
  // emits the same 64-char zero-padded lowercase hex that PoseidonHashService
  // produces. Verified empirically against the vendored tarball.
  //
  // The targeted reads were therefore pure leak with no correctness benefit:
  // each disclosed a nullifier to the RPC provider moments before that same
  // nullifier appeared on-chain.
  console.log('Checking nullifier status from the bulk on-chain index…');
  const noteComp = noteComputationService;
  await noteIndex.refresh({ force: true });
  // Resolve "really spendable" — same test the withdraw modal does:
  //
  // 1. Nullifier already consumed on-chain? Answered locally from the union of
  //    Transacted.nullifierHashes and Ragequit.nullifierHash over bulk logs.
  //
  // 2. ASP has approved the note's label (= the deposit's association-set
  //    entry)? The UI's ⏳ pending icon == label not yet in the set. Ask
  //    `aspClient.getMerkleProof(labelHash)`, which resolves locally from the
  //    bulk leaf set: success → approved and spendable; throws → still pending
  //    or rejected, not spendable.
  const nullifierStatus = new Map<string, boolean>();
  const labelApproved = new Map<string, boolean>();
  console.log('Resolving nullifier / ASP label status per note…');
  for (const n of all) {
    const nullifier = noteComp.computeNullifier(keystoreManager.getPrivateNullifyingKey(), n.commitment);
    nullifierStatus.set(n.commitment, noteIndex.isNullifierSpent(nullifier as `0x${string}`));

    const labelHash = hashService.hash([n.label]);
    try {
      await (aspClient as any).getMerkleProof(labelHash);
      labelApproved.set(n.commitment, true);
    } catch {
      labelApproved.set(n.commitment, false);
    }
  }
  console.log('All notes (with on-chain + ASP checks):');
  for (const n of all) {
    console.log(
      `  ${n.commitment.slice(0, 12)}… status=${String(n.status)} value=${n.value}`
        + ` onChainSpent=${nullifierStatus.get(n.commitment)}`
        + ` aspApproved=${labelApproved.get(n.commitment)}`,
    );
  }

  const spendable = all
    .filter((n) => n.tokenId.toLowerCase() === ETH_ASSET)
    .filter((n) => !nullifierStatus.get(n.commitment))
    .filter((n) => labelApproved.get(n.commitment))
    .filter((n) => {
      try { return BigInt(n.value) >= TRANSFER_AMOUNT_WEI; } catch { return false; }
    })
    .sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : -1));
  if (spendable.length === 0) {
    console.log('All notes:', all.map((n) => ({ c: n.commitment.slice(0, 10), v: n.value, s: n.status })));
    throw new Error(`No active ETH notes with value >= ${TRANSFER_AMOUNT_WEI}.`);
  }
  const inputNote = spendable[0];
  console.log('Input note:', inputNote.commitment, 'value=', inputNote.value);

  // Heal createdAtBlock against on-chain timestamps. NoteManager stores
  // placeholder values (`0x0` from optimistic `addOutputNotes`, or the
  // log.blockNumber from pre-a97f6ef discoveries). Either way, the
  // witness-tree leaf `Poseidon(commitment, createdAtBlock)` won't match
  // the real `Poseidon(commitment, block.timestamp)` on-chain and
  // prepareTransfer fails with "Leaf <hash> not found in tree".
  console.log('Healing note timestamps against PoolVault.commitmentTimestamp…');
  const { healed, removed } = await healNoteTimestamps(noteManager as any, noteIndex);
  console.log(`Healed ${healed} timestamps, removed ${removed} phantoms.`);

  // ── Look up recipient's viewing pubkey ─────────────────────────
  const recipientViewingKey = await keystoreInteractor.getViewingKey(RECIPIENT);
  console.log('Recipient viewing key (raw from Keystore):', recipientViewingKey);
  if (!recipientViewingKey || /^0x0*$/i.test(recipientViewingKey)) {
    throw new Error(`Recipient ${RECIPIENT} has no viewing key registered on-chain.`);
  }

  // ── prepareTransfer (discoverable mode) ────────────────────────
  // Sepolia v8: the relayer signer EOA submits transfers directly to
  // PoolVault.transact (no PrivacyPoolRelay wrapper on the transfer
  // route), so the processor in the proof has to be the signer EOA.
  const transferProcessor = SEPOLIA_TRANSFER_PROCESSOR_ADDRESS as Hex;
  const amountHex = `0x${TRANSFER_AMOUNT_WEI.toString(16)}` as Hex;

  console.log('Calling prepareTransfer (unified discoverable / out-of-band)…');
  const result = await session.prepareTransfer({
    inputCommitments: [inputNote.commitment],
    amount: amountHex,
    tokenId: ETH_ASSET,
    relayAddress: transferProcessor,
    feeAmount: '0x0' as Hex,
    processorAddress: transferProcessor,
    recipientDiscoveryData: { evmAddress: RECIPIENT },
  });
  const exec = result.executeOptions;
  console.log(
    'Prepared:',
    JSON.stringify(
      {
        recipientCommitment: exec.recipientPendingNotes[0]?.commitment,
        changeCommitment: exec.changePendingNotes[0]?.commitment,
        spentNoteCount: exec.spentNotes.length,
        relayOptions: result.relayOptions?.length,
      },
      null,
      2,
    ),
  );

  // ── Submit via HTTPS relayer ───────────────────────────────────
  const option = result.relayOptions?.[0];
  if (!option) throw new Error('No relayer quotes returned.');
  console.log('Submitting via relayer:', option.selectedQuote.relayerInfo.name);
  // The relay hook refuses an unplanned transfer (services/transfer-relay-outputs.ts).
  // Recipient outputs do not depend on the fee, so the prepared ones are the plan.
  const relayCheck = expectTransferRelay({
    signedRelayerCommitment: String(option.selectedQuote.quote.feeCommitment.signedRelayerCommitment),
    inputCount: option.inputCommitments.length,
    changeCount: exec.changePendingNotes.length,
    recipientCommitments: exec.recipientPendingNotes.map((n) => n.commitment),
  });
  const transferResult = await session.relayTransfer(option).finally(() => relayCheck.release());
  const hash = transferResult.txReceipt.txHash;
  console.log('\nRelay submitted. Tx hash:', hash);
  console.log('Explorer:', `https://sepolia.etherscan.io/tx/${hash}`);
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
