/**
 * Sui Privacy Pools circuit witness construction (browser-safe).
 *
 * Builds the snarkjs `fullProve` input objects for the three flows, plus the
 * derived values the PTB builders need (commitments, nullifier hashes, context,
 * ciphertext blob). Signal names + field semantics are reproduced from the
 * AUTHORITATIVE references:
 *   - circuits/sui_transact.circom (wrapper signal declarations)
 *   - sdk/scripts/generate-gvk-deposit-fixture.mjs  (native deposit)
 *   - sdk/scripts/generate-gvk-wrapper-fixtures.mjs  (SuiTransact wrapper)
 *   - v2-monorepo Deposit/Ragequit/NoteCommitment circuits
 *
 * Flow summary:
 *   - DEPOSIT  : native circuit, public inputs [tokenId, value, context], output
 *                outputCommitment. NO GVK on deposit (reverted, fa910bd).
 *   - TRANSACT : SuiTransact wrapper, 1 public input (publicInputHash). GVK
 *                encryption proven in-circuit; ciphertext blob submitted to PTB.
 *   - RAGEQUIT : native circuit, 7 signals. NO GVK.
 *
 * IMPORTANT: this does NOT use the SDK's higher-level witness.mjs (which uses the
 * V2 2-input commitment `Poseidon(value,label)`); that does not match the deployed
 * circuits. The V1-style note crypto in ./crypto matches them.
 */

import {
  poseidonHashN,
  calculateNoteAddressHash,
  calculatePrecommitment,
  calculateNoteCommitment,
  calculateNullifierHash,
  calculateDepositLabel,
  calculateLabelHash,
  calculateKeystoreLeaf,
  calculateNullifyingKeyHash,
  computeAuthDigestDirectKey,
  calculateTimestampedLeaf,
  computeDepositContext,
  computeTransactContext,
  addressToBytes32,
  addressToU256,
  encodePayoutRouting,
} from './crypto';
import {
  createTreeWithLeaves,
  generateProof,
  padSiblings,
  type MerkleProof,
} from './merkle';
import {
  encryptNotes,
  ciphertextBlob,
  type NotePlaintext,
} from './global-view-key';
import { STATE_MAX_DEPTH, KEYSTORE_MAX_DEPTH, ASP_MAX_DEPTH } from './constants';

/** snarkjs input object — all signals as decimal strings or arrays thereof. */
export type CircuitInputs = Record<string, unknown>;

// ============================ DEPOSIT ============================

export interface DepositWitnessParams {
  value: bigint;
  tokenId: bigint;
  noteSecret: bigint;
  depositSecret: bigint;
  /** Owner's Sui address as a field element (addressToU256). */
  ownerAddress: bigint;
  /** Opaque note hint bytes bound into context (default empty). */
  noteHint?: Uint8Array;
  /** Opaque encrypted note bytes bound into context (default empty). */
  noteData?: Uint8Array;
}

export interface DepositWitness {
  inputs: CircuitInputs;
  /** Derived note commitment (PTB outputCommitment arg). */
  commitment: bigint;
  label: bigint;
  precommitment: bigint;
  /** Context bound by the proof (the contract recomputes + checks this). */
  context: bigint;
  noteHint: Uint8Array;
  noteData: Uint8Array;
}

/**
 * Build a native deposit witness. The circuit's public inputs are
 * [tokenId, value, context]; `outputCommitment` is the public output.
 */
export async function buildDepositWitness(params: DepositWitnessParams): Promise<DepositWitness> {
  const { value, tokenId, noteSecret, depositSecret, ownerAddress } = params;
  const noteHint = params.noteHint ?? new Uint8Array(0);
  const noteData = params.noteData ?? new Uint8Array(0);

  if (value <= 0n) throw new Error('deposit value must be > 0');

  const noteAddressHash = await calculateNoteAddressHash(ownerAddress, noteSecret);
  // metadata = 0 for standard notes (v2.0).
  const precommitment = await calculatePrecommitment(noteAddressHash, tokenId, value, 0n);
  const label = await calculateDepositLabel(precommitment, depositSecret);
  const commitment = await calculateNoteCommitment(noteAddressHash, tokenId, value, 0n, label);

  const context = computeDepositContext(noteHint, noteData);

  // Signal names MUST match Deposit.circom exactly.
  const inputs: CircuitInputs = {
    tokenId: tokenId.toString(),
    value: value.toString(),
    context: context.toString(),
    noteAddressHash: noteAddressHash.toString(),
    depositSecret: depositSecret.toString(),
  };

  return { inputs, commitment, label, precommitment, context, noteHint, noteData };
}

// ============================ TRANSACT (SuiTransact wrapper) ============================

/** An input note being spent. */
export interface InputNote {
  value: bigint;
  tokenId: bigint;
  label: bigint;
  noteSecret: bigint;
  /** Owner address (field element) used in the note commitment. */
  ownerAddress: bigint;
  /** Insertion timestamp of the note's state leaf (seconds). */
  timestamp: bigint;
  /** State-tree leaf index of the note's timestamped commitment leaf. */
  leafIndex: number;
}

/** An output note being created. */
export interface OutputNote {
  value: bigint;
  tokenId: bigint;
  label: bigint;
  noteSecret: bigint;
  /** Recipient address (field element). */
  ownerAddress: bigint;
}

export interface TransactWitnessParams {
  inputNotes: InputNote[];
  outputNotes: OutputNote[];

  /** Owner identity (the spender). */
  ownerAddress: bigint;
  privateNullifyingKey: bigint;
  /** Revocable key for direct-key auth; equals nullifying key in this flow. */
  privateRevocableKey: bigint;

  /** Withdrawal amount (0 for a pure transfer). */
  amountOut: bigint;
  /** Token id for withdrawal (must be 0 when amountOut == 0). */
  tokenIdOut: bigint;

  /** Current roots (must be known/latest on-chain). */
  stateRoot: bigint;
  keystoreRoot: bigint;
  aspRoot: bigint;

  /** state-tree Merkle proofs, one per input note (ordered with inputNotes). */
  stateMerkleProofs: MerkleProof[];
  /** keystore Merkle proof for the spender's leaf. */
  keystoreMerkleProof: MerkleProof;
  /** ASP Merkle proofs, one per input note label. */
  aspMerkleProofs: MerkleProof[];

  /**
   * Whether the pool has GVK enabled (read from chain: pool.gvk_enabled).
   * When true (default), the GVK wrapper circuit is used and a ciphertext is
   * built + bound; gvk MUST be the on-chain pool.gvk(). When false, the plain
   * wrapper is used: no gvk/encryption signals, EMPTY ciphertext, and
   * publicInputHash = origHash (matches pool.move's gvk_enabled branch).
   */
  gvkEnabled?: boolean;
  /** Global View Key public point [x, y] (on-chain pool.gvk()). Ignored when plain. */
  gvk: [bigint, bigint];
  /** Encryption randomness (BabyJubJub scalar). Random per proof. Ignored when plain. */
  encryptionRandomness: bigint;

  /** Context binding: 32-byte processor address bytes (@0x0 => allow any sender). */
  processorBytes: Uint8Array;
  processorData?: Uint8Array;
  /** Opaque per-output note hint/data bound into context (empty or length M). */
  noteHints?: Uint8Array[];
  noteData?: Uint8Array[];
}

export interface TransactWitness {
  inputs: CircuitInputs;
  /** Nullifier hashes for each input note (PTB arg). */
  nullifierHashes: bigint[];
  /** Output commitments (PTB arg). */
  outputCommitments: bigint[];
  /** GVK ciphertext blob [ephX, ephY, enc_0..4 per note] (PTB arg). */
  ciphertext: bigint[];
  context: bigint;
}

/**
 * Build a SuiTransact wrapper witness (all NxM, including 1x1). Produces the
 * circuit inputs AND the derived PTB args (nullifier hashes, output commitments,
 * ciphertext blob). The wrapper proves transaction validity AND the
 * publicInputHash binding; the on-chain contract recomputes that hash from these
 * same values, so they must be consistent.
 */
export async function buildTransactWitness(params: TransactWitnessParams): Promise<TransactWitness> {
  const {
    inputNotes, outputNotes,
    ownerAddress, privateNullifyingKey, privateRevocableKey,
    amountOut, tokenIdOut, stateRoot, keystoreRoot, aspRoot,
    stateMerkleProofs, keystoreMerkleProof, aspMerkleProofs,
    gvk, encryptionRandomness, processorBytes,
  } = params;

  const N = inputNotes.length;
  const M = outputNotes.length;
  // GVK enabled by default (the contract default); the caller threads the live
  // pool.gvk_enabled flag in. Plain path => empty ciphertext + no gvk signals.
  const gvkEnabled = params.gvkEnabled ?? true;
  const processorData = params.processorData ?? new Uint8Array(0);
  const noteHints = params.noteHints ?? [];
  const noteData = params.noteData ?? [];

  if (N < 1 || M < 1) throw new Error('transact requires >= 1 input and >= 1 output note');
  if (stateMerkleProofs.length !== N) throw new Error('stateMerkleProofs length must equal input count');
  if (aspMerkleProofs.length !== N) throw new Error('aspMerkleProofs length must equal input count');

  // Internal-transfer invariant: amountOut == 0 => tokenIdOut MUST be 0.
  const canonicalTokenIdOut = amountOut === 0n ? 0n : tokenIdOut;
  if (amountOut === 0n && tokenIdOut !== 0n) {
    throw new Error('tokenIdOut must be 0 on an internal transfer (amountOut == 0)');
  }

  // Value conservation: sum(inputs) == amountOut + sum(outputs).
  const totalIn = inputNotes.reduce((s, n) => s + n.value, 0n);
  const totalOut = outputNotes.reduce((s, n) => s + n.value, 0n);
  if (totalIn !== amountOut + totalOut) {
    throw new Error(
      `value conservation violated: sum(in)=${totalIn} != amountOut(${amountOut}) + sum(out)(${totalOut})`,
    );
  }

  // Derived: nullifier hashes + input commitments.
  const nullifierHashes: bigint[] = [];
  for (let i = 0; i < N; i++) {
    const note = inputNotes[i];
    const nah = await calculateNoteAddressHash(note.ownerAddress, note.noteSecret);
    const commitment = await calculateNoteCommitment(nah, note.tokenId, note.value, 0n, note.label);
    nullifierHashes.push(await calculateNullifierHash(privateNullifyingKey, commitment));
  }

  // Derived: output commitments.
  const outputCommitments: bigint[] = [];
  for (let j = 0; j < M; j++) {
    const note = outputNotes[j];
    const nah = await calculateNoteAddressHash(note.ownerAddress, note.noteSecret);
    outputCommitments.push(
      await calculateNoteCommitment(nah, note.tokenId, note.value, 0n, note.label),
    );
  }

  // GVK encryption of output notes — ciphertext blob for the PTB. The circuit
  // recomputes encryption internally from the raw output fields + randomness + GVK.
  // Plain path (gvk_enabled == false on chain): the plain wrapper has no GVK
  // signals and the contract requires an EMPTY ciphertext (E_INVALID_CIPHERTEXT
  // otherwise), with publicInputHash = origHash.
  let ciphertext: bigint[] = [];
  if (gvkEnabled) {
    const notes: NotePlaintext[] = outputNotes.map((n) => ({
      value: n.value,
      tokenId: n.tokenId,
      label: n.label,
      ownerAddress: n.ownerAddress,
      noteSecret: n.noteSecret,
    }));
    const encResult = await encryptNotes(gvk, encryptionRandomness, notes);
    ciphertext = ciphertextBlob(encResult);
  }

  // Context binding (length-prefixed, matches pool.move::transact_internal).
  const context = computeTransactContext(processorBytes, processorData, noteHints, noteData);

  // All inputs share a single tokenId (single-asset transact).
  const tokenId = inputNotes[0].tokenId;

  // Circuit signal arrays. Pad siblings to MAX depth; pass per-leaf depth separately.
  const stateSiblings = stateMerkleProofs.map((p) =>
    padSiblings(p.siblings, STATE_MAX_DEPTH).map(String),
  );
  const stateTreeDepth = stateMerkleProofs.map((p) => p.siblings.length.toString());
  const stateLeafIndex = stateMerkleProofs.map((p) => p.index.toString());

  const aspSiblings = aspMerkleProofs.map((p) =>
    padSiblings(p.siblings, ASP_MAX_DEPTH).map(String),
  );
  const aspTreeDepth = aspMerkleProofs.map((p) => p.siblings.length.toString());
  const aspLeafIndex = aspMerkleProofs.map((p) => p.index.toString());

  const ksSiblings = padSiblings(keystoreMerkleProof.siblings, KEYSTORE_MAX_DEPTH).map(String);

  // Signal names MUST match circuits/sui_transact.circom exactly.
  const inputs: CircuitInputs = {
    // "Public" signals (private in SuiTransact, folded into publicInputHash).
    stateRoot: stateRoot.toString(),
    keystoreRoot: keystoreRoot.toString(),
    associationSetRoot: aspRoot.toString(),
    amountOut: amountOut.toString(),
    tokenIdOut: canonicalTokenIdOut.toString(),
    context: context.toString(),

    // Authorization / identity.
    ownerAddress: ownerAddress.toString(),
    privateNullifyingKey: privateNullifyingKey.toString(),
    privateRevocableKey: privateRevocableKey.toString(),
    keystoreLeafIndex: keystoreMerkleProof.index.toString(),
    keystoreSiblings: ksSiblings,
    keystoreTreeDepth: keystoreMerkleProof.siblings.length.toString(),

    // Input notes (arrays over N).
    tokenId: tokenId.toString(),
    noteSecret: inputNotes.map((n) => n.noteSecret.toString()),
    value: inputNotes.map((n) => n.value.toString()),
    label: inputNotes.map((n) => n.label.toString()),
    stateLeafIndex,
    stateSiblings,
    stateTreeDepth,
    associationSetLeafIndex: aspLeafIndex,
    associationSetSiblings: aspSiblings,
    associationSetTreeDepth: aspTreeDepth,
    timestamp: inputNotes.map((n) => n.timestamp.toString()),

    // Output notes (arrays over M) — raw fields for in-circuit encryption.
    outputOwnerAddress: outputNotes.map((n) => n.ownerAddress.toString()),
    outputNoteSecret: outputNotes.map((n) => n.noteSecret.toString()),
    outputValue: outputNotes.map((n) => n.value.toString()),
    outputLabel: outputNotes.map((n) => n.label.toString()),
  };

  // GVK encryption signals exist ONLY in the GVK wrapper (proof_type 1). The
  // plain wrapper (proof_type 3) declares no encryptionRandomness/gvkX/gvkY, so
  // adding them would make snarkjs reject the witness.
  if (gvkEnabled) {
    inputs.encryptionRandomness = encryptionRandomness.toString();
    inputs.gvkX = gvk[0].toString();
    inputs.gvkY = gvk[1].toString();
  }

  return { inputs, nullifierHashes, outputCommitments, ciphertext, context };
}

// ============================ RAGEQUIT ============================

export interface RagequitNote {
  value: bigint;
  tokenId: bigint;
  label: bigint;
  noteSecret: bigint;
  ownerAddress: bigint;
}

export interface RagequitWitnessParams {
  note: RagequitNote;
  keystoreRoot: bigint;
  /** Owner's Sui address as a field element (addressToU256). */
  ownerAddress: bigint;
  keystoreMerkleProof: MerkleProof;
  privateNullifyingKey: bigint;
  privateRevocableKey: bigint;
}

export interface RagequitWitness {
  inputs: CircuitInputs;
  nullifierHash: bigint;
  commitment: bigint;
}

/**
 * The zero owner address. A note received via an addressless / payment-key flow
 * binds its on-chain commitment to this value and therefore CANNOT ragequit (the
 * pool pays the proof's ownerAddress, which 0 can never satisfy). Mirrors the
 * SDK's EMPTY_ADDRESS (sdk/src/constants.mjs) used by RagequitAddresslessNote.
 */
export const EMPTY_ADDRESS = 0n;

/**
 * Raised when a ragequit is attempted on an addressless (owner == 0) note. The
 * note's on-chain commitment binds the zero address, so the ragequit proof can
 * never satisfy the pool payout — fail here, BEFORE the opaque proof-generation
 * failure (and before the on-chain abort). Mirrors the SDK's
 * `RagequitAddresslessNote` (sdk/src/errors.mjs).
 */
export class RagequitAddresslessNoteError extends Error {
  constructor(commitment?: bigint) {
    super(
      `Ragequit failed: note${commitment != null ? ' ' + commitment : ''} has no owner ` +
        `address (received via an addressless / payment-key flow). Such notes cannot ragequit.`,
    );
    this.name = 'RagequitAddresslessNoteError';
  }
}

/** Build a native ragequit witness (7 public signals). */
export async function buildRagequitWitness(
  params: RagequitWitnessParams,
): Promise<RagequitWitness> {
  const { note, keystoreRoot, ownerAddress, keystoreMerkleProof } = params;
  const { privateNullifyingKey, privateRevocableKey } = params;

  // Addressless-note guard (mirrors the SDK): an owner-0 note binds the zero
  // address on-chain and the pool pays the proof's ownerAddress, so it can never
  // satisfy the payout. Reject BEFORE proving rather than build an unusable
  // witness that only fails opaquely on-chain. Both the note's bound owner and
  // the proof's payout owner must be non-zero.
  if (note.ownerAddress === EMPTY_ADDRESS || ownerAddress === EMPTY_ADDRESS) {
    const nahForId = await calculateNoteAddressHash(note.ownerAddress, note.noteSecret);
    const commitmentForId = await calculateNoteCommitment(
      nahForId,
      note.tokenId,
      note.value,
      0n,
      note.label,
    );
    throw new RagequitAddresslessNoteError(commitmentForId);
  }

  const nah = await calculateNoteAddressHash(note.ownerAddress, note.noteSecret);
  const commitment = await calculateNoteCommitment(nah, note.tokenId, note.value, 0n, note.label);
  const nullifierHash = await calculateNullifierHash(privateNullifyingKey, commitment);

  const ksSiblings = padSiblings(keystoreMerkleProof.siblings, KEYSTORE_MAX_DEPTH).map(String);

  // Signal names MUST match Ragequit.circom exactly.
  const inputs: CircuitInputs = {
    keystoreRoot: keystoreRoot.toString(),
    ownerAddress: ownerAddress.toString(),
    value: note.value.toString(),
    tokenId: note.tokenId.toString(),
    label: note.label.toString(),
    noteSecret: note.noteSecret.toString(),
    metadata: '0',
    privateNullifyingKey: privateNullifyingKey.toString(),
    privateRevocableKey: privateRevocableKey.toString(),
    keystoreLeafIndex: keystoreMerkleProof.index.toString(),
    keystoreSiblings: ksSiblings,
    keystoreTreeDepth: keystoreMerkleProof.siblings.length.toString(),
  };

  return { inputs, nullifierHash, commitment };
}

// ============================ Re-exports for convenience ============================

export {
  poseidonHashN,
  calculateNoteAddressHash,
  calculatePrecommitment,
  calculateNoteCommitment,
  calculateNullifierHash,
  calculateDepositLabel,
  calculateLabelHash,
  calculateKeystoreLeaf,
  calculateNullifyingKeyHash,
  computeAuthDigestDirectKey,
  calculateTimestampedLeaf,
  computeDepositContext,
  computeTransactContext,
  addressToBytes32,
  addressToU256,
  encodePayoutRouting,
};
export { createTreeWithLeaves, generateProof, padSiblings } from './merkle';
export type { MerkleProof } from './merkle';
export {
  encryptNotes,
  ciphertextBlob,
  decryptNote,
  deriveGlobalViewKeyPubKey,
  generateEncryptionRandomness,
  BABYJUB_BASE8,
  BABYJUB_ORDER,
} from './global-view-key';
