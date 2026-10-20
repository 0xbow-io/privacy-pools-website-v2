import { describe, it, expect } from 'vitest';
import {
  buildTransactWitness,
  calculateNoteAddressHash,
  calculateNoteCommitment,
  calculateTimestampedLeaf,
  calculateLabelHash,
  calculateKeystoreLeaf,
  calculateNullifyingKeyHash,
  computeAuthDigestDirectKey,
  createTreeWithLeaves,
} from '@/services/sui-witness/witness';
import { getRoot } from '@/services/sui-witness/merkle';
import { getPoseidon } from '@/services/sui-witness/crypto';
import {
  reconstructStateProofs,
  reconstructKeystoreProof,
  reconstructAspProofs,
  type SpendNote,
} from '@/services/sui-witness/reconstruct';
import { makeFakeReader, type ReaderState } from './helpers/fixtures';
import { SDK_AVAILABLE, loadSdkMerkle } from './helpers/sdk';

/**
 * NON-POWER-OF-2 MERKLE INDEX REGRESSION (the live-relay-withdraw-e2e bug).
 *
 * `LeanIMT.generateProof(tree, leafIndex)` returns a proof whose `.index` is a
 * REMAPPED bit-path index, NOT the raw `indexOf` leaf index. The circuit's
 * `BinaryMerkleRoot` consumes that bit-path `index`: at level i it hashes with
 * the sibling as left/right according to bit `(index >> i) & 1`. For a
 * NON-POWER-OF-2 tree the remapped `proof.index` differs from the raw leaf index
 * for the "promoted" leaves (the ones whose subtree is shallower), so feeding the
 * RAW index reconstructs a WRONG root and the proof fails
 * (`inputMerkleProofs[i].out !== stateRoot`).
 *
 * The fix (proven live in scripts/live-relay-withdraw-e2e.mjs) is to thread
 * `proof.index` into the circuit's `*LeafIndex` signal, NEVER the raw `indexOf`,
 * and the per-leaf depth from `proof.siblings.length`. The website witness
 * builder (services/sui-witness/witness.ts) already does this; THIS test pins it
 * so a revert to the raw `indexOf` index is caught here, not on-chain.
 *
 * Target case: a 7-leaf state tree. LeanIMT places the 7th leaf (raw indexOf 6)
 * at bit-path index 3 with a SHORTER proof (depth 2 vs 3). For that leaf the raw
 * index (6) and proof.index (3) DIVERGE; reconstructing with the raw index yields
 * the wrong root. (Earlier leaves coincide, so they would NOT catch the bug.)
 */

const OWNER = 12345678901234567890n;
const TOKEN = 9999n;
const NK = 33333333333333n;

/**
 * The exact circuit `BinaryMerkleRoot(MAX_DEPTH)` reconstruction: walk `depth`
 * levels, at level i hash (node, sibling) when bit (index>>i)&1 == 0 else
 * (sibling, node). This mirrors the circom template the proof is checked against,
 * so a wrong `index` produces a wrong root here exactly as it would in-circuit.
 */
async function binaryMerkleRoot(
  leaf: bigint,
  depth: number,
  index: number,
  siblings: bigint[],
): Promise<bigint> {
  const poseidon = await getPoseidon();
  const H = (a: bigint, b: bigint): bigint => poseidon.F.toObject(poseidon([a, b])) as bigint;
  let node = leaf;
  for (let i = 0; i < depth; i++) {
    const bit = (index >> i) & 1;
    const sib = siblings[i];
    node = bit === 0 ? H(node, sib) : H(sib, node);
  }
  return node;
}

/**
 * Build a 7-leaf state tree spending the LAST leaf (raw indexOf 6, proof.index 3
 * — the divergent one), plus a keystore tree with an odd (3) leaf count whose
 * spender leaf is also promoted, and a 1-label ASP set.
 */
async function buildNonPow2Scenario() {
  // ONE note to spend, but the state tree has 7 leaves total (6 fillers + ours
  // last). The note's leaf must land at raw index 6 -> proof.index 3.
  const note: SpendNote & { timestamp: bigint } = {
    value: 100n,
    tokenId: TOKEN,
    label: 1006n,
    noteSecret: 7n,
    ownerAddress: OWNER,
    timestamp: 1_700_000_006n,
  };

  const nah = await calculateNoteAddressHash(note.ownerAddress, note.noteSecret);
  const commitment = await calculateNoteCommitment(nah, note.tokenId, note.value, 0n, note.label);
  const noteLeaf = await calculateTimestampedLeaf(commitment, note.timestamp);

  // 6 deterministic filler leaves (in-field constants), then our note leaf at
  // index 6 -> a 7-leaf NON-POWER-OF-2 tree.
  const fillers = [111n, 222n, 333n, 444n, 555n, 666n];
  const stateLeaves = [...fillers, noteLeaf];
  const stateTree = await createTreeWithLeaves(stateLeaves);
  const stateRoot = getRoot(stateTree);

  const timestamps = new Map<bigint, bigint>();
  timestamps.set(commitment, note.timestamp);

  // Keystore tree: 3 leaves (odd) with the spender leaf LAST (raw index 2 ->
  // proof.index 1, depth 1) — exercises the same remap on the keystore signal.
  const nkHash = await calculateNullifyingKeyHash(NK);
  const authDigest = await computeAuthDigestDirectKey(NK);
  const ksLeaf = await calculateKeystoreLeaf(OWNER, nkHash, authDigest);
  const ksLeaves = [11111n, 22222n, ksLeaf];
  const ksTree = await createTreeWithLeaves(ksLeaves);
  const keystoreRoot = getRoot(ksTree);

  // ASP tree: single approved label (our note's).
  const approvedLabels = [note.label];
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
    gvkEnabled: false,
    gvk: { x: 0n, y: 0n },
  };
  const reader = makeFakeReader(state);

  return { note, approvedLabels, stateRoot, keystoreRoot, aspRoot, reader, noteLeaf };
}

describe('non-power-of-2 Merkle index (live-relay-withdraw-e2e bug regression)', () => {
  it('the target leaf actually has proof.index != raw indexOf (the divergence exists)', async () => {
    const s = await buildNonPow2Scenario();
    const tree = await createTreeWithLeaves(
      await s.reader.reconstructStateLeaves(),
    );
    const rawIndex = tree.indexOf(s.noteLeaf);
    expect(rawIndex).toBe(6); // raw leaf index

    const { generateProof } = await import('@/services/sui-witness/merkle');
    const proof = generateProof(tree, rawIndex);
    expect(proof.index).toBe(3); // remapped bit-path index
    expect(proof.index).not.toBe(rawIndex); // <-- the divergence the bug rides on
    expect(proof.siblings.length).toBe(2); // shorter (promoted) proof
  });

  it('reconstructStateProofs reconstructs the real root for the divergent leaf', async () => {
    const s = await buildNonPow2Scenario();
    const spendNotes: SpendNote[] = [
      { value: s.note.value, tokenId: s.note.tokenId, label: s.note.label, noteSecret: s.note.noteSecret, ownerAddress: s.note.ownerAddress },
    ];
    const rec = await reconstructStateProofs(s.reader as never, spendNotes);

    // (a) reconstructed root equals the tree root (and is in the root_buffer, else
    //     reconstructStateProofs would have thrown).
    expect(rec.stateRoot).toBe(s.stateRoot);
    expect(rec.proofs).toHaveLength(1);
    expect(rec.proofs[0].root).toBe(s.stateRoot);
    // raw indexOf is 6; the proof's bit-path index is the remapped 3.
    expect(rec.leafIndices).toEqual([6]);
    expect(rec.proofs[0].index).toBe(3);
  });

  it('the WITNESS stateLeafIndex + siblings reproduce the root via BinaryMerkleRoot bit-path logic', async () => {
    const s = await buildNonPow2Scenario();
    const spendNotes: SpendNote[] = [
      { value: s.note.value, tokenId: s.note.tokenId, label: s.note.label, noteSecret: s.note.noteSecret, ownerAddress: s.note.ownerAddress },
    ];

    const state = await reconstructStateProofs(s.reader as never, spendNotes);
    const ks = await reconstructKeystoreProof(s.reader as never, OWNER, NK, NK);
    const asp = await reconstructAspProofs(s.reader as never, spendNotes, s.approvedLabels);

    const witnessInputNotes = spendNotes.map((n, i) => ({
      ...n,
      timestamp: state.timestamps[i],
      leafIndex: state.leafIndices[i],
    }));

    const w = await buildTransactWitness({
      inputNotes: witnessInputNotes,
      outputNotes: [{ value: s.note.value, tokenId: TOKEN, label: s.note.label, noteSecret: 9n, ownerAddress: OWNER }],
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
      processorData: new Uint8Array(0),
      noteHints: [],
      noteData: [],
    });

    // The witness's stateLeafIndex MUST be the remapped proof.index (3), NOT the
    // raw leaf index (6). This is the exact value the on-chain circuit's
    // BinaryMerkleRoot consumes.
    const stateLeafIndex = (w.inputs.stateLeafIndex as string[]).map(Number);
    const stateTreeDepth = (w.inputs.stateTreeDepth as string[]).map(Number);
    expect(stateLeafIndex).toEqual([3]); // <-- proof.index, would be [6] on the bug
    expect(stateTreeDepth).toEqual([2]); // <-- proof.siblings.length, the per-leaf depth

    // Reproduce the circuit: with the WITNESS index + the proof siblings, the
    // BinaryMerkleRoot reconstructs the real state root.
    const reconstructed = await binaryMerkleRoot(
      state.proofs[0].leaf,
      stateTreeDepth[0],
      stateLeafIndex[0],
      state.proofs[0].siblings,
    );
    expect(reconstructed).toBe(s.stateRoot);

    // PIN THE BUG: feeding the RAW indexOf (6) into the SAME BinaryMerkleRoot
    // logic must produce a DIFFERENT (wrong) root — i.e. the circuit would reject.
    // If someone reverts witness.ts to use the raw index, the assertion above
    // (stateLeafIndex == [3]) already fails; this confirms WHY it matters.
    const rawIndex = state.leafIndices[0]; // 6
    const wrongRoot = await binaryMerkleRoot(
      state.proofs[0].leaf,
      stateTreeDepth[0],
      rawIndex,
      state.proofs[0].siblings,
    );
    expect(wrongRoot).not.toBe(s.stateRoot);
  });

  it('keystore witness index is the remapped proof.index for an odd (3-leaf) keystore tree', async () => {
    const s = await buildNonPow2Scenario();
    const ks = await reconstructKeystoreProof(s.reader as never, OWNER, NK, NK);

    // Spender leaf is at raw index 2 of a 3-leaf tree -> promoted to bit-path
    // index 1 with depth 1.
    expect(ks.leafIndex).toBe(2); // raw indexOf
    expect(ks.proof.index).toBe(1); // remapped bit-path index
    expect(ks.proof.index).not.toBe(ks.leafIndex);

    const reconstructed = await binaryMerkleRoot(
      ks.proof.leaf,
      ks.proof.siblings.length,
      ks.proof.index,
      ks.proof.siblings,
    );
    expect(reconstructed).toBe(s.keystoreRoot);

    // Raw index would reconstruct the wrong root.
    const wrong = await binaryMerkleRoot(
      ks.proof.leaf,
      ks.proof.siblings.length,
      ks.leafIndex,
      ks.proof.siblings,
    );
    expect(wrong).not.toBe(s.keystoreRoot);
  });

  // Cross-check the website's LeanIMT against the SDK's merkle.mjs for the
  // identical 7-leaf tree: same root, same remapped index, same siblings. This
  // anchors the port to the source-of-truth's remapping behavior.
  describe.skipIf(!SDK_AVAILABLE)('cross-check vs SDK merkle.mjs', () => {
    it('SDK generateProof yields the SAME remapped index + siblings for leaf 6 of a 7-leaf tree', async () => {
      const s = await buildNonPow2Scenario();
      const stateLeaves = await s.reader.reconstructStateLeaves();

      // Port tree.
      const portTree = await createTreeWithLeaves(stateLeaves);
      const { generateProof: portGenerateProof, indexOf: portIndexOf } = await import(
        '@/services/sui-witness/merkle'
      );
      const portIdx = portIndexOf(portTree, s.noteLeaf);
      const portProof = portGenerateProof(portTree, portIdx);

      // SDK tree (source of truth).
      const sdk = await loadSdkMerkle();
      const sdkTree = await sdk.createTree();
      sdk.insertLeaves(sdkTree, stateLeaves);
      const sdkIdx = sdk.indexOf(sdkTree, s.noteLeaf);
      const sdkProof = sdk.generateProof(sdkTree, sdkIdx);

      expect(sdk.getRoot(sdkTree)).toBe(s.stateRoot);
      expect(portIdx).toBe(sdkIdx); // raw indexOf agrees (6)
      expect(portProof.index).toBe(sdkProof.index); // remapped index agrees (3)
      expect(portProof.index).not.toBe(portIdx); // divergence holds
      expect(portProof.siblings).toEqual(sdkProof.siblings); // siblings agree
      expect(portProof.root).toBe(sdkProof.root); // roots agree
    });
  });
});
