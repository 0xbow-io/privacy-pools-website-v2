import { loadPoseidon } from '@/services/crypto-runtime';
/**
 * Global View Key (GVK) — in-circuit proven note encryption (browser-safe port).
 *
 * Ported faithfully from the protocol SDK's `global-view-key.mjs`. The SuiTransact
 * wrapper circuit proves that `ciphertext` is correctly computed from the output
 * notes under the GVK; the on-chain contract recomputes the encryption hash and
 * binds it into `publicInputHash` (pool.move::transact_internal lines ~628-644).
 *
 * Scheme (BabyJubJub ECDH + Poseidon keystream over the BN254 scalar field):
 *   ephemeralPubKey = r * G            (G = BABYJUB_BASE8)
 *   sharedSecret    = r * GVK          (ECDH)
 *   symKey          = Poseidon(shared.x, shared.y)
 *   enc_i           = plain_i + Poseidon(symKey, fieldOffset + i)   (field addition)
 *
 * The 5 plaintext fields per note, in order, are:
 *   [value, tokenId, label, ownerAddress, noteSecret]
 *
 * The on-chain ciphertext blob layout is:
 *   [ephPubKeyX, ephPubKeyY, (enc_0..4 for note 0), (enc_0..4 for note 1), ...]
 * with fieldOffset = noteIndex * 5 (so encryptNotes uses one shared ephemeral key).
 */

import { SNARK_SCALAR_FIELD } from './constants';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Poseidon = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BabyJub = any;

let poseidon: Poseidon | null = null;
let babyJub: BabyJub | null = null;

async function init(): Promise<void> {
  if (poseidon && babyJub) return;
  const { buildPoseidon, buildBabyjub } = await loadPoseidon();
  poseidon = await buildPoseidon();
  babyJub = await buildBabyjub();
}

function hash2(a: bigint, b: bigint): bigint {
  return poseidon.F.toObject(poseidon([a, b])) as bigint;
}

/** BabyJubJub base point (generator G = BASE8), same as circomlib babyjub.circom. */
export const BABYJUB_BASE8: [bigint, bigint] = [
  5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  16950150798460657717958625567821834550301663161624707787222815936182638968203n,
];

/** BabyJubJub subgroup order (l). */
export const BABYJUB_ORDER =
  2736030358979909402780800718157159386076813972158567259200215660948447373041n;

export interface NotePlaintext {
  value: bigint;
  tokenId: bigint;
  label: bigint;
  ownerAddress: bigint;
  noteSecret: bigint;
}

export interface EncryptedNote {
  encValue: bigint;
  encTokenId: bigint;
  encLabel: bigint;
  encOwnerAddress: bigint;
  encNoteSecret: bigint;
}

export interface EncryptNotesResult {
  ephPubKeyX: bigint;
  ephPubKeyY: bigint;
  encrypted: EncryptedNote[];
}

/** Generate a random non-zero BabyJubJub encryption scalar (< subgroup order). */
export function generateEncryptionRandomness(): bigint {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let r = 0n;
  for (const b of bytes) r = (r << 8n) | BigInt(b);
  r = r % BABYJUB_ORDER;
  if (r === 0n) r = 1n;
  return r;
}

/** Scalar multiplication on BabyJubJub: point * scalar. */
async function scalarMul(point: [bigint, bigint], scalar: bigint): Promise<[bigint, bigint]> {
  await init();
  const p = [babyJub.F.e(point[0]), babyJub.F.e(point[1])];
  const result = babyJub.mulPointEscalar(p, scalar);
  return [babyJub.F.toObject(result[0]) as bigint, babyJub.F.toObject(result[1]) as bigint];
}

async function deriveSymKey(sharedX: bigint, sharedY: bigint): Promise<bigint> {
  await init();
  return hash2(sharedX, sharedY);
}

async function keystream(symKey: bigint, fieldIndex: number): Promise<bigint> {
  await init();
  return hash2(symKey, BigInt(fieldIndex));
}

function assertField(v: bigint, name: string): void {
  if (typeof v !== 'bigint') throw new Error(`${name} must be bigint`);
  if (v < 0n || v >= SNARK_SCALAR_FIELD) throw new Error(`${name} out of BN254 field range: ${v}`);
}

/** Derive the GVK public key from a private scalar: pubKey = privKey * G. */
export async function deriveGlobalViewKeyPubKey(privKey: bigint): Promise<[bigint, bigint]> {
  return scalarMul(BABYJUB_BASE8, privKey);
}

/**
 * Encrypt multiple output notes under the GVK with a shared ephemeral key.
 * Returns the ephemeral pubkey + per-note encrypted fields, matching the
 * on-chain ciphertext layout and the SuiTransact circuit's encryption.
 */
export async function encryptNotes(
  globalVkPubKey: [bigint, bigint],
  randomness: bigint,
  notes: NotePlaintext[],
): Promise<EncryptNotesResult> {
  await init();

  for (let j = 0; j < notes.length; j++) {
    const n = notes[j];
    assertField(n.value, `notes[${j}].value`);
    assertField(n.tokenId, `notes[${j}].tokenId`);
    assertField(n.label, `notes[${j}].label`);
    assertField(n.ownerAddress, `notes[${j}].ownerAddress`);
    assertField(n.noteSecret, `notes[${j}].noteSecret`);
  }

  const ephPubKey = await scalarMul(BABYJUB_BASE8, randomness);
  const shared = await scalarMul(globalVkPubKey, randomness);
  const symKey = await deriveSymKey(shared[0], shared[1]);

  const encrypted: EncryptedNote[] = [];
  for (let j = 0; j < notes.length; j++) {
    const note = notes[j];
    const fieldOffset = j * 5;
    const fields = [note.value, note.tokenId, note.label, note.ownerAddress, note.noteSecret];
    const enc: bigint[] = [];
    for (let i = 0; i < 5; i++) {
      const ks = await keystream(symKey, fieldOffset + i);
      enc.push((fields[i] + ks) % SNARK_SCALAR_FIELD);
    }
    encrypted.push({
      encValue: enc[0],
      encTokenId: enc[1],
      encLabel: enc[2],
      encOwnerAddress: enc[3],
      encNoteSecret: enc[4],
    });
  }

  return { ephPubKeyX: ephPubKey[0], ephPubKeyY: ephPubKey[1], encrypted };
}

/**
 * Build the flat on-chain ciphertext vector from an encryptNotes result:
 *   [ephPubKeyX, ephPubKeyY, enc_0..4 (note 0), enc_0..4 (note 1), ...]
 * This is what pool.move::transact_internal expects as the `ciphertext` arg
 * (length 2 + 5*M).
 */
export function ciphertextBlob(result: EncryptNotesResult): bigint[] {
  const blob: bigint[] = [result.ephPubKeyX, result.ephPubKeyY];
  for (const e of result.encrypted) {
    blob.push(e.encValue, e.encTokenId, e.encLabel, e.encOwnerAddress, e.encNoteSecret);
  }
  return blob;
}

/** Decrypt a single note's 5 fields with the GVK private scalar (holder side). */
export async function decryptNote(
  globalVkPrivKey: bigint,
  ephPubKeyX: bigint,
  ephPubKeyY: bigint,
  ciphertexts: EncryptedNote,
  noteIndex = 0,
): Promise<NotePlaintext> {
  await init();
  const shared = await scalarMul([ephPubKeyX, ephPubKeyY], globalVkPrivKey);
  const symKey = await deriveSymKey(shared[0], shared[1]);
  const fieldOffset = noteIndex * 5;
  const enc = [
    ciphertexts.encValue,
    ciphertexts.encTokenId,
    ciphertexts.encLabel,
    ciphertexts.encOwnerAddress,
    ciphertexts.encNoteSecret,
  ];
  const dec: bigint[] = [];
  for (let i = 0; i < 5; i++) {
    const ks = await keystream(symKey, fieldOffset + i);
    dec.push((enc[i] - ks + SNARK_SCALAR_FIELD) % SNARK_SCALAR_FIELD);
  }
  return {
    value: dec[0],
    tokenId: dec[1],
    label: dec[2],
    ownerAddress: dec[3],
    noteSecret: dec[4],
  };
}
