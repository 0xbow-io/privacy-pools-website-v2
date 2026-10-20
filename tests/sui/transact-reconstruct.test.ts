import { describe, it, expect } from 'vitest';
import {
  buildTransactWitness,
  calculateNoteAddressHash,
  calculateNoteCommitment,
  calculateNullifierHash,
  calculateTimestampedLeaf,
  calculateLabelHash,
  calculateKeystoreLeaf,
  calculateNullifyingKeyHash,
  computeAuthDigestDirectKey,
  poseidonHashN,
  createTreeWithLeaves,
} from '@/services/sui-witness/witness';
import { getRoot } from '@/services/sui-witness/merkle';
import {
  reconstructStateProofs,
  reconstructKeystoreProof,
  reconstructAspProofs,
  type SpendNote,
} from '@/services/sui-witness/reconstruct';
import { STATE_MAX_DEPTH } from '@/services/sui-witness/constants';
import { makeFakeReader, type ReaderState } from './helpers/fixtures';
import { SDK_AVAILABLE, loadSdkWitness } from './helpers/sdk';

/**
 * FLOW 2/3 — TRANSACT / TRANSFER / WITHDRAW (direct, non-relayed).
 *
 * The hardest seam the UI-flow audit flagged: the Merkle-proof RECONSTRUCTION
 * layer (state/keystore/ASP) that use-sui-session.prepareSpendInputs orchestrates
 * from chain events. These tests inject a fake chain reader returning canned
 * LeavesInserted/keystore/object-field responses and assert the reconstruction +
 * witness produce on-chain-consistent artifacts. Live submission (real Groth16 +
 * pool::transact) is covered by the Node live scripts (live-relay-withdraw-e2e),
 * not here.
 *
 * Scenario uses an ODD input count (3 inputs) to exercise the documented LeanIMT
 * per-leaf-depth gotcha (leaf2 has a shorter proof than leaf0/leaf1).
 */

const OWNER = 12345678901234567890n;
const TOKEN = 9999n;
const NK = 33333333333333n;

/** Build a 3-input spend scenario + the fake reader exposing it. */
async function build3InputScenario(opts: { gvkEnabled?: boolean } = {}) {
  // Three notes to spend, each with its own label/value/secret.
  const notes: (SpendNote & { timestamp: bigint })[] = [
    { value: 100n, tokenId: TOKEN, label: 1001n, noteSecret: 1n, ownerAddress: OWNER, timestamp: 1_700_000_001n },
    { value: 200n, tokenId: TOKEN, label: 1002n, noteSecret: 2n, ownerAddress: OWNER, timestamp: 1_700_000_002n },
    { value: 300n, tokenId: TOKEN, label: 1003n, noteSecret: 3n, ownerAddress: OWNER, timestamp: 1_700_000_003n },
  ];

  const timestamps = new Map<bigint, bigint>();
  const noteLeaves: bigint[] = [];
  for (const n of notes) {
    const nah = await calculateNoteAddressHash(n.ownerAddress, n.noteSecret);
    const commitment = await calculateNoteCommitment(nah, n.tokenId, n.value, 0n, n.label);
    timestamps.set(commitment, n.timestamp);
    noteLeaves.push(await calculateTimestampedLeaf(commitment, n.timestamp));
  }

  // State tree: exactly the three note leaves. With 3 leaves the LeanIMT yields
  // per-leaf depths [2, 2, 1] — the last note leaf gets a SHORTER proof than the
  // first two (the documented odd-leaf-count gotcha). This is the case the
  // per-leaf-depth handling must get right.
  const stateLeaves = [noteLeaves[0], noteLeaves[1], noteLeaves[2]];
  const stateTree = await createTreeWithLeaves(stateLeaves);
  const stateRoot = getRoot(stateTree);

  // Keystore tree: filler + spender leaf.
  const nkHash = await calculateNullifyingKeyHash(NK);
  const authDigest = await computeAuthDigestDirectKey(NK);
  const ksLeaf = await calculateKeystoreLeaf(OWNER, nkHash, authDigest);
  const ksLeaves = [98765n, ksLeaf];
  const ksTree = await createTreeWithLeaves(ksLeaves);
  const keystoreRoot = getRoot(ksTree);

  // ASP tree: labelHash of each note (the approved set).
  const approvedLabels = notes.map((n) => n.label);
  const aspLeaves: bigint[] = [];
  for (const l of approvedLabels) aspLeaves.push(await calculateLabelHash(l));
  const aspTree = await createTreeWithLeaves(aspLeaves);
  const aspRoot = getRoot(aspTree);

  const state: ReaderState = {
    timestamps,
    stateLeaves,
    keystoreLeaves: ksLeaves,
    rootBuffer: [stateRoot],
    keystoreRoot,
    aspRoot,
    gvkEnabled: opts.gvkEnabled ?? true,
    gvk: { x: 0n, y: 0n },
  };
  const reader = makeFakeReader(state);

  return { notes, approvedLabels, stateRoot, keystoreRoot, aspRoot, reader, noteLeaves };
}

describe('state reconstruction from mocked LeavesInserted events', () => {
  it('reconstructs the verified state root + per-note proofs for 3 inputs', async () => {
    const s = await build3InputScenario();
    const spendNotes: SpendNote[] = s.notes.map(({ timestamp, ...n }) => n);

    const rec = await reconstructStateProofs(s.reader as never, spendNotes);

    expect(rec.stateRoot).toBe(s.stateRoot);
    expect(rec.proofs).toHaveLength(3);
    expect(rec.leafIndices).toEqual([0, 1, 2]);
    expect(rec.timestamps).toEqual([1_700_000_001n, 1_700_000_002n, 1_700_000_003n]);
    expect(rec.leafCount).toBe(3);

    // Every reconstructed proof verifies against the reconstructed root.
    for (const p of rec.proofs) expect(p.root).toBe(s.stateRoot);
  });

  it('produces NON-UNIFORM per-leaf depths for an odd-positioned leaf set', async () => {
    const s = await build3InputScenario();
    const spendNotes: SpendNote[] = s.notes.map(({ timestamp, ...n }) => n);
    const rec = await reconstructStateProofs(s.reader as never, spendNotes);

    // The 3-leaf LeanIMT yields depths [2, 2, 1] — the last note leaf has a
    // SHORTER proof than the earlier ones (the documented per-leaf-depth gotcha).
    const depths = rec.proofs.map((p) => p.siblings.length);
    expect(depths).toEqual([2, 2, 1]);
    const unique = new Set(depths);
    expect(unique.size).toBeGreaterThan(1); // not all the same depth

    // Every per-leaf depth is within the circuit max (siblings get padded to it).
    for (const d of depths) expect(d).toBeLessThanOrEqual(STATE_MAX_DEPTH);
  });

  it('FAILS LOUD when a note timestamp is not on-chain (crypto/timestamp mismatch)', async () => {
    const s = await build3InputScenario();
    // Remove one commitment's timestamp -> getCommitmentTimestamp throws.
    const spendNotes: SpendNote[] = s.notes.map(({ timestamp, ...n }) => n);
    const broken = makeFakeReader({
      timestamps: new Map(), // empty -> every lookup throws
      stateLeaves: [],
      keystoreLeaves: [],
      rootBuffer: [],
      keystoreRoot: 0n,
      aspRoot: 0n,
    });
    await expect(reconstructStateProofs(broken as never, spendNotes)).rejects.toThrow(/not found on-chain/);
  });

  it('FAILS LOUD when the reconstructed root is not in the pool root_buffer', async () => {
    const s = await build3InputScenario();
    const spendNotes: SpendNote[] = s.notes.map(({ timestamp, ...n }) => n);
    // A valid reader except the pool root_buffer does not contain the rebuilt
    // root (a stale / out-of-order reconstruction) => E_UNKNOWN_STATE_ROOT.
    const badReader = {
      ...(s.reader as Record<string, unknown>),
      async getPoolRootBuffer() {
        return [] as bigint[];
      },
    };
    await expect(reconstructStateProofs(badReader as never, spendNotes)).rejects.toThrow(/root_buffer/);
  });
});

describe('keystore + ASP reconstruction', () => {
  it('reconstructs the keystore proof + matches current_root', async () => {
    const s = await build3InputScenario();
    const rec = await reconstructKeystoreProof(s.reader as never, OWNER, NK, NK);
    expect(rec.keystoreRoot).toBe(s.keystoreRoot);
    expect(rec.leafIndex).toBe(1);
    expect(rec.proof.root).toBe(s.keystoreRoot);
  });

  it('FAILS when the spender leaf is absent (auth policy not registered)', async () => {
    const s = await build3InputScenario();
    // Wrong NK -> a different keystore leaf, not present on-chain.
    await expect(reconstructKeystoreProof(s.reader as never, OWNER, 999n, 999n)).rejects.toThrow(
      /keystore leaf not found/,
    );
  });

  it('reconstructs ASP proofs against the latest on-chain ASP root', async () => {
    const s = await build3InputScenario();
    const spendNotes: SpendNote[] = s.notes.map(({ timestamp, ...n }) => n);
    const rec = await reconstructAspProofs(s.reader as never, spendNotes, s.approvedLabels);
    expect(rec.aspRoot).toBe(s.aspRoot);
    expect(rec.proofs).toHaveLength(3);
  });

  it('FAILS LOUD when the rebuilt ASP root does not match on-chain (label not approved)', async () => {
    const s = await build3InputScenario();
    const spendNotes: SpendNote[] = s.notes.map(({ timestamp, ...n }) => n);
    // Approve a DIFFERENT label set -> rebuilt root won't match the on-chain root.
    await expect(
      reconstructAspProofs(s.reader as never, spendNotes, [424242n, 525252n]),
    ).rejects.toThrow(/does not match the latest on-chain ASP root/);
  });
});

describe('full 3-input transact witness from reconstructed proofs', () => {
  it('assembles a value-conserving witness with the right N/M arrays', async () => {
    const s = await build3InputScenario();
    const spendNotes: SpendNote[] = s.notes.map(({ timestamp, ...n }) => n);

    const state = await reconstructStateProofs(s.reader as never, spendNotes);
    const ks = await reconstructKeystoreProof(s.reader as never, OWNER, NK, NK);
    const asp = await reconstructAspProofs(s.reader as never, spendNotes, s.approvedLabels);

    // Single output back to self at the full input value (pure transfer).
    const totalIn = spendNotes.reduce((a, n) => a + n.value, 0n);
    const witnessInputNotes = spendNotes.map((n, i) => ({
      ...n,
      timestamp: state.timestamps[i],
      leafIndex: state.leafIndices[i],
    }));

    const w = await buildTransactWitness({
      inputNotes: witnessInputNotes,
      outputNotes: [{ value: totalIn, tokenId: TOKEN, label: 1001n, noteSecret: 9n, ownerAddress: OWNER }],
      ownerAddress: OWNER,
      privateNullifyingKey: NK,
      privateRevocableKey: NK,
      amountOut: 0n,
      tokenIdOut: 0n,
      stateRoot: state.stateRoot,
      keystoreRoot: ks.keystoreRoot,
      aspRoot: asp.aspRoot,
      stateMerkleProofs: state.proofs,
      keystoreMerkleProof: ks.proof,
      aspMerkleProofs: asp.proofs,
      gvkEnabled: false, // plain path for this assertion
      gvk: [0n, 0n],
      encryptionRandomness: 0n,
      processorBytes: new Uint8Array(32),
      processorData: new Uint8Array(0),
      noteHints: [],
      noteData: [],
    });

    expect(w.nullifierHashes).toHaveLength(3);
    expect(w.outputCommitments).toHaveLength(1);

    // The per-leaf depth signal MUST equal the real siblings length per input.
    const stateTreeDepth = w.inputs.stateTreeDepth as string[];
    expect(stateTreeDepth).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(stateTreeDepth[i]).toBe(String(state.proofs[i].siblings.length));
    }

    // nullifier hashes are exactly Poseidon(NK, commitment) per input.
    for (let i = 0; i < 3; i++) {
      const nah = await calculateNoteAddressHash(spendNotes[i].ownerAddress, spendNotes[i].noteSecret);
      const c = await calculateNoteCommitment(nah, TOKEN, spendNotes[i].value, 0n, spendNotes[i].label);
      expect(w.nullifierHashes[i]).toBe(await calculateNullifierHash(NK, c));
    }
  });

  it('REJECTS a witness that violates value conservation', async () => {
    const s = await build3InputScenario();
    const spendNotes: SpendNote[] = s.notes.map(({ timestamp, ...n }) => n);
    const state = await reconstructStateProofs(s.reader as never, spendNotes);
    const ks = await reconstructKeystoreProof(s.reader as never, OWNER, NK, NK);
    const asp = await reconstructAspProofs(s.reader as never, spendNotes, s.approvedLabels);

    const witnessInputNotes = spendNotes.map((n, i) => ({
      ...n,
      timestamp: state.timestamps[i],
      leafIndex: state.leafIndices[i],
    }));

    await expect(
      buildTransactWitness({
        inputNotes: witnessInputNotes,
        // sum(in)=600 but output only 599 with amountOut 0 -> violation.
        outputNotes: [{ value: 599n, tokenId: TOKEN, label: 1001n, noteSecret: 9n, ownerAddress: OWNER }],
        ownerAddress: OWNER,
        privateNullifyingKey: NK,
        privateRevocableKey: NK,
        amountOut: 0n,
        tokenIdOut: 0n,
        stateRoot: state.stateRoot,
        keystoreRoot: ks.keystoreRoot,
        aspRoot: asp.aspRoot,
        stateMerkleProofs: state.proofs,
        keystoreMerkleProof: ks.proof,
        aspMerkleProofs: asp.proofs,
        gvk: [0n, 0n],
        encryptionRandomness: 0n,
        processorBytes: new Uint8Array(32),
      }),
    ).rejects.toThrow(/value conservation violated/);
  });

  it('REJECTS tokenIdOut != 0 on an internal transfer (amountOut == 0)', async () => {
    const s = await build3InputScenario();
    const spendNotes: SpendNote[] = s.notes.map(({ timestamp, ...n }) => n);
    const state = await reconstructStateProofs(s.reader as never, spendNotes);
    const ks = await reconstructKeystoreProof(s.reader as never, OWNER, NK, NK);
    const asp = await reconstructAspProofs(s.reader as never, spendNotes, s.approvedLabels);
    const totalIn = spendNotes.reduce((a, n) => a + n.value, 0n);
    const witnessInputNotes = spendNotes.map((n, i) => ({
      ...n,
      timestamp: state.timestamps[i],
      leafIndex: state.leafIndices[i],
    }));

    await expect(
      buildTransactWitness({
        inputNotes: witnessInputNotes,
        outputNotes: [{ value: totalIn, tokenId: TOKEN, label: 1001n, noteSecret: 9n, ownerAddress: OWNER }],
        ownerAddress: OWNER,
        privateNullifyingKey: NK,
        privateRevocableKey: NK,
        amountOut: 0n,
        tokenIdOut: 7n, // must be 0 when amountOut == 0
        stateRoot: state.stateRoot,
        keystoreRoot: ks.keystoreRoot,
        aspRoot: asp.aspRoot,
        stateMerkleProofs: state.proofs,
        keystoreMerkleProof: ks.proof,
        aspMerkleProofs: asp.proofs,
        gvk: [0n, 0n],
        encryptionRandomness: 0n,
        processorBytes: new Uint8Array(32),
      }),
    ).rejects.toThrow(/tokenIdOut must be 0/);
  });

  // Spirit of the crosscheck: the plain-path publicInputHash IS origHash, and the
  // port must agree with the SDK's computeOrigHash on it.
  describe.skipIf(!SDK_AVAILABLE)('publicInputHash == SDK origHash', () => {
    it('port origHash equals SDK computeOrigHash for the assembled witness', async () => {
      const s = await build3InputScenario();
      const spendNotes: SpendNote[] = s.notes.map(({ timestamp, ...n }) => n);
      const state = await reconstructStateProofs(s.reader as never, spendNotes);
      const ks = await reconstructKeystoreProof(s.reader as never, OWNER, NK, NK);
      const asp = await reconstructAspProofs(s.reader as never, spendNotes, s.approvedLabels);
      const totalIn = spendNotes.reduce((a, n) => a + n.value, 0n);
      const witnessInputNotes = spendNotes.map((n, i) => ({
        ...n,
        timestamp: state.timestamps[i],
        leafIndex: state.leafIndices[i],
      }));

      const w = await buildTransactWitness({
        inputNotes: witnessInputNotes,
        outputNotes: [{ value: totalIn, tokenId: TOKEN, label: 1001n, noteSecret: 9n, ownerAddress: OWNER }],
        ownerAddress: OWNER,
        privateNullifyingKey: NK,
        privateRevocableKey: NK,
        amountOut: 0n,
        tokenIdOut: 0n,
        stateRoot: state.stateRoot,
        keystoreRoot: ks.keystoreRoot,
        aspRoot: asp.aspRoot,
        stateMerkleProofs: state.proofs,
        keystoreMerkleProof: ks.proof,
        aspMerkleProofs: asp.proofs,
        gvkEnabled: false,
        gvk: [0n, 0n],
        encryptionRandomness: 0n,
        processorBytes: new Uint8Array(32),
      });

      const sdkWitness = await loadSdkWitness();
      const sdkOrigHash = await sdkWitness.computeOrigHash({
        nullifierHashes: w.nullifierHashes,
        outputCommitments: w.outputCommitments,
        stateRoot: state.stateRoot,
        keystoreRoot: ks.keystoreRoot,
        aspRoot: asp.aspRoot,
        amountOut: 0n,
        tokenIdOut: 0n,
        context: w.context,
      });

      const portOrigHash = await poseidonHashN([
        ...w.nullifierHashes,
        ...w.outputCommitments,
        BigInt(w.inputs.stateRoot as string),
        BigInt(w.inputs.keystoreRoot as string),
        BigInt(w.inputs.associationSetRoot as string),
        BigInt(w.inputs.amountOut as string),
        BigInt(w.inputs.tokenIdOut as string),
        BigInt(w.inputs.context as string),
      ]);

      expect(portOrigHash).toBe(sdkOrigHash);
    });
  });
});
