import { loadPoseidon } from '@/services/crypto-runtime';
/**
 * Browser-safe BN254 crypto primitives for Sui Privacy Pools witness construction.
 *
 * Ported faithfully from the protocol SDK's `crypto.mjs` + the fixture generators
 * (the on-chain / in-circuit source of truth). Uses circomlibjs Poseidon (the same
 * BN254 Poseidon snarkjs/the circuits use) and js-sha3 keccak256 (matching Sui's
 * `sui::hash::keccak256`, which is Ethereum Keccak-256, NOT NIST SHA3-256).
 *
 * CRITICAL field/encoding semantics (must match the contract + circuit exactly):
 *  - Note crypto is V1-STYLE (matches Deposit/Ragequit/Transact circuits which use
 *    the NoteCommitment helper):
 *      noteAddressHash = Poseidon(ownerAddress, noteSecret)
 *      precommitment   = Poseidon(noteAddressHash, tokenId, value, metadata=0)
 *      commitment      = Poseidon(precommitment, label)
 *      nullifierHash   = Poseidon(nullifyingKey, commitment)
 *  - State-tree leaf is the TAGGED 3-input form (G1, v2-sync):
 *      commitmentLeaf = Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp)
 *  - Context binding is length-prefixed keccak256 % field (INTL-12, matches
 *    pool.move::append_length_prefixed + compute_context).
 *
 * NOTE: the commitment is the V1-style cascade reproduced here
 * (`commitment = Poseidon(precommitment, label)` over a 4-input precommitment) —
 * NOT a 2-input `Poseidon(value, label)` shorthand. An earlier SDK `witness.mjs`
 * carried that buggy shorthand; it was corrected in the protocol SDK
 * (note-crypto alignment, commit d31f81d) so the SDK and this module now agree.
 * The fixture generators (generate-gvk-*.mjs) remain the authoritative reference.
 */

import { keccak256 as keccak256Hex } from 'js-sha3';
import {
  SNARK_SCALAR_FIELD,
  COMMITMENT_LEAF_TAG,
  NULLIFIER_LEAF_TAG,
} from './constants';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Poseidon = any;

let poseidonInstance: Poseidon | null = null;

/** Get or initialize the circomlibjs Poseidon hash function (BN254 scalar field). */
export async function getPoseidon(): Promise<Poseidon> {
  if (!poseidonInstance) {
    const { buildPoseidon } = await loadPoseidon();
    poseidonInstance = await buildPoseidon();
  }
  return poseidonInstance;
}

/** Poseidon hash of N field elements, returned as a canonical bigint. */
export async function poseidonHashN(inputs: bigint[]): Promise<bigint> {
  const poseidon = await getPoseidon();
  return poseidon.F.toObject(poseidon(inputs)) as bigint;
}

export async function poseidonHash2(a: bigint, b: bigint): Promise<bigint> {
  return poseidonHashN([a, b]);
}

export async function poseidonHash3(a: bigint, b: bigint, c: bigint): Promise<bigint> {
  return poseidonHashN([a, b, c]);
}

export async function poseidonHash4(
  a: bigint,
  b: bigint,
  c: bigint,
  d: bigint,
): Promise<bigint> {
  return poseidonHashN([a, b, c, d]);
}

// === Field / byte encoding helpers ===

/** Keccak256 of raw bytes reduced mod the BN254 scalar field. */
export function keccakModField(data: Uint8Array): bigint {
  const hashHex = keccak256Hex(data);
  return BigInt('0x' + hashHex) % SNARK_SCALAR_FIELD;
}

/** 8-byte little-endian length prefix for `len`. */
function u64LE(len: number): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt(len);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Append `data` as [8-byte LE length || data]. Matches pool.move append_length_prefixed. */
function appendLengthPrefixed(parts: Uint8Array[], data: Uint8Array): void {
  parts.push(u64LE(data.length));
  parts.push(data);
}

/**
 * Deposit context = keccak256(lenPrefix(noteHint) || lenPrefix(noteData)) % field.
 * Matches pool.move::deposit context_preimage construction.
 */
export function computeDepositContext(noteHint: Uint8Array, noteData: Uint8Array): bigint {
  const parts: Uint8Array[] = [];
  appendLengthPrefixed(parts, noteHint);
  appendLengthPrefixed(parts, noteData);
  return keccakModField(concatBytes(parts));
}

/**
 * Transact context = keccak256(
 *   processorBytes(32) || lenPrefix(processorData) ||
 *   lenPrefix(noteHints[i])... || lenPrefix(noteData[i])...
 * ) % field.
 * Matches pool.move::transact_internal context_preimage construction.
 *
 * @param processorBytes 32-byte address bytes (processor.to_bytes()).
 */
export function computeTransactContext(
  processorBytes: Uint8Array,
  processorData: Uint8Array,
  noteHints: Uint8Array[],
  noteData: Uint8Array[],
): bigint {
  const parts: Uint8Array[] = [processorBytes];
  appendLengthPrefixed(parts, processorData);
  for (const h of noteHints) appendLengthPrefixed(parts, h);
  for (const d of noteData) appendLengthPrefixed(parts, d);
  return keccakModField(concatBytes(parts));
}

/** Convert a bigint to a 32-byte big-endian Uint8Array. */
export function bigintToBytes32BE(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Convert a Sui address (0x-hex) to its 32-byte big-endian bytes, matching
 * Move's `address::to_bytes()` (Sui addresses are 32 bytes, left-zero-padded).
 */
export function addressToBytes32(address: string): Uint8Array {
  const hex = (address.startsWith('0x') ? address.slice(2) : address).padStart(64, '0');
  return bigintToBytes32BE(BigInt('0x' + hex));
}

/** Max u64 — the on-chain fee field width (PayoutRouting fee_amount). */
const U64_MAX_PAYOUT = (1n << 64n) - 1n;

/**
 * Encode the relay PayoutRouting blob carried in `processor_data` for a relayed
 * withdrawal. The proof binds this into its context (via computeTransactContext
 * with processor = relayer), and the relayer's on-chain
 * `relay::relay_withdrawal` decodes it (`decode_payout`) + recomputes the SAME
 * context from `ctx.sender()` (the relayer) + this data, so the proof's context
 * MUST equal it or the pool aborts E_INVALID_PROOF.
 *
 * Layout (72 bytes), matching sources/relay.move::encode_payout +
 * sdk/src/relay.mjs::encodePayoutRouting exactly:
 *   [0..32)   recipient      32 bytes, big-endian (address::to_bytes)
 *   [32..64)  feeRecipient   32 bytes, big-endian
 *   [64..72)  feeAmount       8 bytes, u64 little-endian
 *
 * @param recipient     final withdrawal recipient (0x-hex Sui address)
 * @param feeRecipient  fee receiver (0x-hex; usually the relayer)
 * @param feeAmount     relay fee in base units (u64)
 */
export function encodePayoutRouting(
  recipient: string,
  feeRecipient: string,
  feeAmount: bigint,
): Uint8Array {
  if (feeAmount < 0n || feeAmount > U64_MAX_PAYOUT) {
    throw new Error(`payout feeAmount ${feeAmount} does not fit in u64`);
  }
  const out = new Uint8Array(72);
  out.set(addressToBytes32(recipient), 0);
  out.set(addressToBytes32(feeRecipient), 32);
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, feeAmount, true); // little-endian
  out.set(new Uint8Array(view.buffer), 64);
  return out;
}

// === V1-style note crypto (matches the circuits' NoteCommitment helper) ===

/** noteAddressHash = Poseidon(ownerAddress, noteSecret). */
export async function calculateNoteAddressHash(
  ownerAddress: bigint,
  noteSecret: bigint,
): Promise<bigint> {
  return poseidonHash2(ownerAddress, noteSecret);
}

/** precommitment = Poseidon(noteAddressHash, tokenId, value, metadata). */
export async function calculatePrecommitment(
  noteAddressHash: bigint,
  tokenId: bigint,
  value: bigint,
  metadata: bigint,
): Promise<bigint> {
  return poseidonHash4(noteAddressHash, tokenId, value, metadata);
}

/**
 * Full note commitment from raw fields:
 *   commitment = Poseidon(Poseidon(noteAddressHash, tokenId, value, metadata), label).
 */
export async function calculateNoteCommitment(
  noteAddressHash: bigint,
  tokenId: bigint,
  value: bigint,
  metadata: bigint,
  label: bigint,
): Promise<bigint> {
  const precommitment = await calculatePrecommitment(noteAddressHash, tokenId, value, metadata);
  return poseidonHash2(precommitment, label);
}

/** nullifierHash = Poseidon(nullifyingKey, commitment) — matches circuit exactly. */
export async function calculateNullifierHash(
  nullifyingKey: bigint,
  commitment: bigint,
): Promise<bigint> {
  return poseidonHash2(nullifyingKey, commitment);
}

/** label = Poseidon(precommitment, depositSecret). */
export async function calculateDepositLabel(
  precommitment: bigint,
  depositSecret: bigint,
): Promise<bigint> {
  return poseidonHash2(precommitment, depositSecret);
}

/** labelHash = Poseidon(label) — the ASP-tree leaf value. */
export async function calculateLabelHash(label: bigint): Promise<bigint> {
  return poseidonHashN([label]);
}

/** keystoreLeaf = Poseidon(address, nullifyingKeyHash, authDigest). */
export async function calculateKeystoreLeaf(
  address: bigint,
  nullifyingKeyHash: bigint,
  authDigest: bigint,
): Promise<bigint> {
  return poseidonHash3(address, nullifyingKeyHash, authDigest);
}

/** authDigest for direct-key auth = Poseidon(0, privateRevocableKey). */
export async function computeAuthDigestDirectKey(privateRevocableKey: bigint): Promise<bigint> {
  return poseidonHash2(0n, privateRevocableKey);
}

/** nullifyingKeyHash = Poseidon(privateNullifyingKey) (single-input Poseidon). */
export async function calculateNullifyingKeyHash(privateNullifyingKey: bigint): Promise<bigint> {
  return poseidonHashN([privateNullifyingKey]);
}

/** State-tree commitment leaf: Poseidon(COMMITMENT_LEAF_TAG, commitment, timestamp). */
export async function calculateTimestampedLeaf(
  commitment: bigint,
  timestamp: bigint,
): Promise<bigint> {
  return poseidonHash3(COMMITMENT_LEAF_TAG, commitment, timestamp);
}

/** State-tree nullifier leaf: Poseidon(NULLIFIER_LEAF_TAG, nullifierHash, timestamp). */
export async function calculateNullifierLeaf(
  nullifierHash: bigint,
  timestamp: bigint,
): Promise<bigint> {
  return poseidonHash3(NULLIFIER_LEAF_TAG, nullifierHash, timestamp);
}

/** Convert a Sui address to u256 matching Move's address_to_u256() (mod BN254 field). */
export function addressToU256(address: string): bigint {
  return BigInt(address) % SNARK_SCALAR_FIELD;
}

/** Generate a random BN254 field element (31 bytes => always < field). */
export function randomFieldElement(): bigint {
  const bytes = new Uint8Array(31);
  globalThis.crypto.getRandomValues(bytes);
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  return value;
}
