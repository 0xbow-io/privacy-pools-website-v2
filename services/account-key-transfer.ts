import { gcm } from '@noble/ciphers/aes.js';

/**
 * Account key, web -> phone, over one QR code.
 *
 * The phone makes a random transfer code and shows it. The user types it on
 * the web, which encrypts the account key under a key derived from that code
 * and shows the ciphertext as a QR. The phone scans it and decrypts with the
 * code it already holds. The code never leaves the phone except through the
 * user's fingers, and the web never shows it.
 *
 * Code: 9 random symbols + 1 Luhn mod N check symbol, shown XXXX-XXXX-XX.
 * The alphabet is Crockford base32 minus 0 and 1, so no 0/O or 1/I/L (and
 * no U, as in Crockford). 30 symbols: 9 x log2(30) = 44.2 random bits.
 * N must be even: with an odd N, Luhn mod N misses some single-symbol typos
 * on the doubled positions (with 31 symbols, '7' and 'P' collide).
 *
 * KDF: Argon2id, 64 MiB, 3 passes, parallelism 1, 32-byte output, fresh
 * 16-byte salt per export. Cipher: AES-256-GCM, fresh 12-byte nonce.
 * Both run byte-identically on web (hash-wasm) and phone (native Argon2);
 * see services/__tests__/account-key-transfer.test.ts for the shared vector.
 *
 * Nothing here touches the network or any storage.
 */

export const TRANSFER_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const N = TRANSFER_CODE_ALPHABET.length; // 30
export const TRANSFER_CODE_RANDOM_CHARS = 9;
export const TRANSFER_CODE_LENGTH = TRANSFER_CODE_RANDOM_CHARS + 1;

export const TRANSFER_PAYLOAD_PREFIX = 'ppv2-ak1:';
const PAYLOAD_VERSION = 1;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Frozen. Changing any of these breaks every phone already in the field. */
export const TRANSFER_KDF = Object.freeze({
  type: 'argon2id' as const,
  memoryKiB: 64 * 1024,
  passes: 3,
  parallelism: 1,
  hashLength: 32,
});

/** How long the web shows the QR before hiding it. */
export const TRANSFER_QR_TTL_MS = 45_000;

/** Argon2id(password, salt) with TRANSFER_KDF params -> 32 raw bytes. */
export type TransferKdf = (password: Uint8Array, salt: Uint8Array) => Promise<Uint8Array>;

type RandomFill = (bytes: Uint8Array) => Uint8Array;

function defaultRandom(bytes: Uint8Array): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) throw new Error('No secure random source.');
  return c.getRandomValues(bytes);
}

function randomBytes(length: number, fill: RandomFill = defaultRandom): Uint8Array {
  const out = new Uint8Array(length);
  fill(out);
  return out;
}

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

function codePoint(ch: string): number {
  return TRANSFER_CODE_ALPHABET.indexOf(ch);
}

/** Luhn mod N check symbol for `body` (all symbols in the alphabet). */
export function transferCodeCheckChar(body: string): string {
  let factor = 2;
  let sum = 0;
  for (let i = body.length - 1; i >= 0; i--) {
    const cp = codePoint(body[i]);
    if (cp < 0) throw new Error('Invalid code symbol.');
    let addend = factor * cp;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / N) + (addend % N);
    sum += addend;
  }
  return TRANSFER_CODE_ALPHABET[(N - (sum % N)) % N];
}

function luhnValid(code: string): boolean {
  let factor = 1;
  let sum = 0;
  for (let i = code.length - 1; i >= 0; i--) {
    const cp = codePoint(code[i]);
    if (cp < 0) return false;
    let addend = factor * cp;
    factor = factor === 2 ? 1 : 2;
    addend = Math.floor(addend / N) + (addend % N);
    sum += addend;
  }
  return sum % N === 0;
}

/** A fresh code from the CSPRNG (rejection-sampled, no modulo bias). */
export function generateTransferCode(fill: RandomFill = defaultRandom): string {
  const limit = 256 - (256 % N); // 240
  let body = '';
  while (body.length < TRANSFER_CODE_RANDOM_CHARS) {
    const buf = randomBytes(16, fill);
    for (const b of buf) {
      if (b < limit && body.length < TRANSFER_CODE_RANDOM_CHARS) body += TRANSFER_CODE_ALPHABET[b % N];
    }
    buf.fill(0);
  }
  return body + transferCodeCheckChar(body);
}

/**
 * Canonical form of a typed code (any case, dashes/spaces ignored), or null
 * when it is the wrong length, has a symbol outside the alphabet, or fails
 * the check symbol.
 */
export function normalizeTransferCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  if (code.length !== TRANSFER_CODE_LENGTH) return null;
  return luhnValid(code) ? code : null;
}

/** XXXX-XXXX-XX */
export function formatTransferCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
}

// ---------------------------------------------------------------------------
// Payload: ppv2-ak1: + base64url(v | salt16 | nonce12 | ciphertext+tag)
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += B64[n & 63];
  }
  return out;
}

export function base64UrlToBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < text.length; i += 4) {
    const n = (B64.indexOf(text[i]) << 18)
      | (B64.indexOf(text[i + 1]) << 12)
      | ((i + 2 < text.length ? B64.indexOf(text[i + 2]) : 0) << 6)
      | (i + 3 < text.length ? B64.indexOf(text[i + 3]) : 0);
    out[o++] = (n >> 16) & 255;
    if (i + 2 < text.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < text.length) out[o++] = n & 255;
  }
  return out;
}

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0x7f;
  return out;
}

function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Header bytes are authenticated, so a QR re-labelled to another version fails. */
function aad(): Uint8Array {
  const prefix = asciiBytes(TRANSFER_PAYLOAD_PREFIX);
  const out = new Uint8Array(prefix.length + 1);
  out.set(prefix);
  out[prefix.length] = PAYLOAD_VERSION;
  return out;
}

export function isTransferPayload(text: string): boolean {
  return text.startsWith(TRANSFER_PAYLOAD_PREFIX);
}

export type SealOptions = {
  /** Canonical code (normalizeTransferCode output). */
  code: string;
  /** The encoded account key. */
  plaintext: string;
  kdf: TransferKdf;
  /** Test vectors only. */
  salt?: Uint8Array;
  /** Test vectors only. */
  nonce?: Uint8Array;
};

export const KDF_FAILED_MESSAGE = 'Could not run the key check on this device. Try again.';

/**
 * Argon2id through the injected KDF. Any failure (WASM out of memory, the
 * native module throwing) or a wrong-sized output becomes one short message,
 * so a raw engine error never reaches the screen.
 */
async function derive(kdf: TransferKdf, code: string, salt: Uint8Array): Promise<Uint8Array> {
  let key: Uint8Array;
  try {
    key = await kdf(asciiBytes(code), salt);
  } catch {
    throw new Error(KDF_FAILED_MESSAGE);
  }
  if (!(key instanceof Uint8Array) || key.length !== TRANSFER_KDF.hashLength) {
    if (key instanceof Uint8Array) key.fill(0);
    throw new Error(KDF_FAILED_MESSAGE);
  }
  return key;
}

export async function sealAccountKeyForTransfer(opts: SealOptions): Promise<string> {
  const code = normalizeTransferCode(opts.code);
  if (!code) throw new Error('That code is not valid.');
  const salt = opts.salt ?? randomBytes(SALT_BYTES);
  const nonce = opts.nonce ?? randomBytes(NONCE_BYTES);
  if (salt.length !== SALT_BYTES || nonce.length !== NONCE_BYTES) throw new Error('Bad salt or nonce.');
  const key = await derive(opts.kdf, code, salt);
  try {
    const pt = utf8Encode(opts.plaintext);
    const ct = gcm(key, nonce, aad()).encrypt(pt);
    pt.fill(0);
    const body = new Uint8Array(1 + SALT_BYTES + NONCE_BYTES + ct.length);
    body[0] = PAYLOAD_VERSION;
    body.set(salt, 1);
    body.set(nonce, 1 + SALT_BYTES);
    body.set(ct, 1 + SALT_BYTES + NONCE_BYTES);
    return TRANSFER_PAYLOAD_PREFIX + bytesToBase64Url(body);
  } finally {
    key.fill(0);
  }
}

export type OpenOptions = {
  code: string;
  payload: string;
  kdf: TransferKdf;
};

/** Throws a short user-facing message on any failure. */
export async function openAccountKeyTransfer(opts: OpenOptions): Promise<string> {
  const code = normalizeTransferCode(opts.code);
  if (!code) throw new Error('That code is not valid.');
  if (!isTransferPayload(opts.payload)) throw new Error('Not a Privacy Pools key QR.');
  const body = base64UrlToBytes(opts.payload.slice(TRANSFER_PAYLOAD_PREFIX.length));
  if (!body || body.length < 1 + SALT_BYTES + NONCE_BYTES + TAG_BYTES + 1) throw new Error('This QR is damaged.');
  if (body[0] !== PAYLOAD_VERSION) throw new Error('Update the app to read this QR.');
  const salt = body.slice(1, 1 + SALT_BYTES);
  const nonce = body.slice(1 + SALT_BYTES, 1 + SALT_BYTES + NONCE_BYTES);
  const ct = body.slice(1 + SALT_BYTES + NONCE_BYTES);
  const key = await derive(opts.kdf, code, salt);
  let pt: Uint8Array;
  try {
    pt = gcm(key, nonce, aad()).decrypt(ct);
  } catch {
    throw new Error('Wrong code, or the QR expired. Start again.');
  } finally {
    key.fill(0);
  }
  try {
    return utf8Decode(pt);
  } catch {
    throw new Error('This QR is damaged.');
  } finally {
    pt.fill(0);
  }
}
