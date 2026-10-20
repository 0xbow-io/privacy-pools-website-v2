/**
 * Recipient note encryption (browser-safe port of the SDK's note-crypto.mjs).
 *
 * This is the OFF-CHAIN encrypted note blob (`noteData`) addressed to the
 * recipient's secp256k1 viewing key — distinct from the GVK in-circuit encryption.
 * It is opaque to the contract (only bound into `context` via keccak), so it does
 * not affect proof validity; it exists so the recipient can recover their note.
 *
 * Scheme (matches v2-monorepo CryptoService + SDK note-crypto.mjs):
 *   sharedSecret = ECDH(senderPriv, recipientPub).x   (secp256k1)
 *   key          = SHA256(sharedSecret)
 *   ciphertext   = nonce(24) || XChaCha20-Poly1305(key, nonce).encrypt(payload)
 *   payload      = noteSecret(32) || value(32) || tokenId(32) || label(32)  (all BE)
 *
 * NOTE: the website ships @noble/curves@2 / @noble/ciphers@2, whose APIs take
 * Uint8Array (not hex strings) and use `.js`-suffixed subpaths. This port adapts
 * the SDK (which targeted @noble v1) accordingly while keeping byte semantics
 * identical.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { sha256 } from '@noble/hashes/sha2.js';

export interface NotePayload {
  noteSecret: bigint;
  value: bigint;
  tokenId: bigint;
  label: bigint;
}

function stripHexPrefix(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = stripHexPrefix(hex);
  const padded = clean.length % 2 === 0 ? clean : '0' + clean;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function concatBytes(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function writeBigint256BE(buf: Uint8Array, offset: number, value: bigint): void {
  let v = value;
  for (let i = 31; i >= 0; i--) {
    buf[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function readBigint256BE(buf: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 32; i++) value = (value << 8n) | BigInt(buf[offset + i]);
  return value;
}

/** ECDH x-coordinate (32 bytes) for secp256k1. Inputs are hex strings. */
export function ecdh(privateKeyHex: string, publicKeyHex: string): Uint8Array {
  const priv = hexToBytes(privateKeyHex);
  const pub = hexToBytes(publicKeyHex);
  const sharedPoint = secp256k1.getSharedSecret(priv, pub); // 33-byte compressed point
  return sharedPoint.slice(1); // x-coordinate
}

/** Encode a note payload into the 128-byte plaintext (4 * 32 BE). */
export function encodeNotePayload(p: NotePayload): Uint8Array {
  const buf = new Uint8Array(128);
  writeBigint256BE(buf, 0, p.noteSecret);
  writeBigint256BE(buf, 32, p.value);
  writeBigint256BE(buf, 64, p.tokenId);
  writeBigint256BE(buf, 96, p.label);
  return buf;
}

export function decodeNotePayload(payload: Uint8Array): NotePayload {
  if (payload.length !== 128) throw new Error(`Invalid payload length: ${payload.length}`);
  return {
    noteSecret: readBigint256BE(payload, 0),
    value: readBigint256BE(payload, 32),
    tokenId: readBigint256BE(payload, 64),
    label: readBigint256BE(payload, 96),
  };
}

/** Encrypt with XChaCha20-Poly1305: output is nonce(24) || ciphertext || tag(16). */
export function encrypt(data: Uint8Array, sharedSecret: Uint8Array): Uint8Array {
  const key = sha256(sharedSecret);
  const nonce = new Uint8Array(24);
  globalThis.crypto.getRandomValues(nonce);
  const cipher = xchacha20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(data);
  return concatBytes(nonce, ciphertext);
}

export function decrypt(ciphertext: Uint8Array, sharedSecret: Uint8Array): Uint8Array {
  const key = sha256(sharedSecret);
  const nonce = ciphertext.slice(0, 24);
  const encrypted = ciphertext.slice(24);
  const cipher = xchacha20poly1305(key, nonce);
  return cipher.decrypt(encrypted);
}

/** Encrypt a note for a recipient given their compressed secp256k1 viewing pubkey. */
export function encryptNote(
  payload: NotePayload,
  senderPrivKeyHex: string,
  recipientPubKeyHex: string,
): Uint8Array {
  const sharedSecret = ecdh(senderPrivKeyHex, recipientPubKeyHex);
  return encrypt(encodeNotePayload(payload), sharedSecret);
}

export function decryptNote(
  encryptedPayload: Uint8Array,
  recipientPrivKeyHex: string,
  senderPubKeyHex: string,
): NotePayload {
  const sharedSecret = ecdh(recipientPrivKeyHex, senderPubKeyHex);
  return decodeNotePayload(decrypt(encryptedPayload, sharedSecret));
}

/** Derive the compressed secp256k1 viewing public key (0x-hex) from a private key. */
export function deriveViewingPublicKey(privateKeyHex: string): string {
  const pub = secp256k1.getPublicKey(hexToBytes(privateKeyHex), true);
  return '0x' + bytesToHex(pub);
}

/** Generate a random 32-byte secret. */
export function generateSecret(): Uint8Array {
  const out = new Uint8Array(32);
  globalThis.crypto.getRandomValues(out);
  return out;
}
