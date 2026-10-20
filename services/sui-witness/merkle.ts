/**
 * Browser-safe client-side LeanIMT for generating Merkle proofs.
 * Ported from the protocol SDK's `merkle.mjs` (uses @zk-kit/lean-imt + circomlibjs
 * Poseidon, identical to the on-chain LeanIMT node hashing).
 *
 * CRITICAL (see ppv2-sui Lessons Learned): the per-leaf proof depth is
 * `proof.siblings.length`, NOT the tree max depth. LeanIMT yields different proof
 * depths per leaf position (odd leaf counts especially). The BinaryMerkleRoot
 * circuit input `*TreeDepth` MUST be the per-leaf siblings length. Callers must
 * pad siblings to the circuit's MAX depth but pass the real depth separately.
 */

// @zk-kit/lean-imt ships its own types; LeanIMT<bigint> with a binary hash.
import { LeanIMT } from '@zk-kit/lean-imt';
import { getPoseidon } from './crypto';

export interface MerkleProof {
  root: bigint;
  leaf: bigint;
  index: number;
  /** Sibling hashes, REAL length = per-leaf proof depth. */
  siblings: bigint[];
  /** Per-level direction bits derived from the leaf index. */
  pathIndices: number[];
}

/** Create a LeanIMT whose node hash is Poseidon(left, right) over BN254. */
export async function createTree(): Promise<LeanIMT<bigint>> {
  const poseidon = await getPoseidon();
  const hash = (a: bigint, b: bigint): bigint => poseidon.F.toObject(poseidon([a, b])) as bigint;
  return new LeanIMT<bigint>(hash);
}

/** Create a LeanIMT pre-populated with `leaves` (insertMany for efficiency). */
export async function createTreeWithLeaves(leaves: bigint[]): Promise<LeanIMT<bigint>> {
  const tree = await createTree();
  if (leaves.length > 0) tree.insertMany(leaves);
  return tree;
}

export function insertLeaf(tree: LeanIMT<bigint>, leaf: bigint): void {
  tree.insert(leaf);
}

export function getRoot(tree: LeanIMT<bigint>): bigint {
  if (tree.size === 0) return 0n;
  return tree.root;
}

export function indexOf(tree: LeanIMT<bigint>, leaf: bigint): number {
  return tree.indexOf(leaf);
}

/**
 * Generate a Merkle proof for a leaf index. `siblings.length` is the per-leaf
 * proof depth (do not assume uniform depth across leaves).
 */
export function generateProof(tree: LeanIMT<bigint>, leafIndex: number): MerkleProof {
  const proof = tree.generateProof(leafIndex);
  return {
    root: proof.root,
    leaf: proof.leaf,
    index: proof.index,
    siblings: proof.siblings,
    pathIndices: proof.siblings.map((_, i) => (proof.index >> i) & 1),
  };
}

/** Pad a siblings array to `targetDepth` with zeros (circuit fixed-width input). */
export function padSiblings(siblings: bigint[], targetDepth: number): bigint[] {
  const padded = [...siblings];
  while (padded.length < targetDepth) padded.push(0n);
  return padded;
}
