// Passkey EOA: the app's on-chain signer, derived from the WebAuthn PRF of the
// privacypools.com passkey (the same passkey the web uses).
//
// What it is, and what it is NOT:
//   - It is ONLY the secp256k1 key that signs on-chain transactions (deposits,
//     approvals, keystore registration) and, when it is the picked account,
//     the EIP-712 derivation payload, exactly like any EOA wallet would.
//   - It is NOT the privacy account's spend root. plans/007 §13.5: the spend
//     root is a portable wrapped root, never PRF-as-root. Nothing here feeds
//     services/passkey-derivation.ts, and the salt + info below are dedicated
//     to this key so it is independent of every other PRF use.
//
// Key handling rules (Pat, 2026-10-01: "same tricks as MetaMask ... ask for
// passkey for any operation that needs it, dont keep anything in memory"):
//   1. No persisted, cached, or session-long key. Every signature is its own
//      passkey prompt: PRF -> HKDF -> key -> sign -> zero.
//   2. Key material is Uint8Array only. Never a string, hex, JSON, bigint we
//      own, log line, Error message, React state, context, ref, or a closure
//      that outlives the call. Only the public ADDRESS may be stored.
//   3. Every buffer (PRF output, HKDF PRK/OKM, private key, digest) is
//      overwritten with zeros in a `finally`, success or failure, and the
//      reference is dropped.
//   4. No long-lived signer object: sign the digest with @noble/curves
//      directly. viem only builds and hashes the unsigned payload.
//   5. No logger, console, Sentry or debug capture anywhere in this feature.
//      Enforced by services/__tests__/passkey-eoa-key-hygiene.test.ts.
//
// Limits we cannot close from JS: the native bridge hands the PRF output over
// as a base64 string (Android Credential Manager speaks JSON, iOS returns a
// JSON string), and @noble/curves turns the key into a bigint internally.
// Neither can be zeroed; both are short-lived and unreferenced after the call.

import { extract, expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { getAddress, type Address } from 'viem';

/** WebAuthn PRF eval.first salt for this key. Frozen: changing it changes every EOA. */
export const PASSKEY_EOA_PRF_SALT_LABEL = 'ppv2-passkey-eoa:prf-salt:v1';
/** HKDF-Extract salt. Frozen. */
export const PASSKEY_EOA_HKDF_SALT_LABEL = 'ppv2-passkey-eoa:hkdf-salt';
/** HKDF-Expand info, versioned. Frozen. */
export const PASSKEY_EOA_HKDF_INFO_LABEL = 'ppv2-passkey-eoa-v1';

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A fresh copy each call so a caller zeroing it cannot corrupt the next request. */
export function passkeyEoaPrfSalt(): Uint8Array {
  return utf8(PASSKEY_EOA_PRF_SALT_LABEL);
}

/** Test seam: sees every secret buffer this module allocates. No-op in the app. */
let observeSecretBuffer: ((buf: Uint8Array) => void) | null = null;
export function __observeSecretBuffersForTest(fn: ((buf: Uint8Array) => void) | null): void {
  observeSecretBuffer = fn;
}
function track(buf: Uint8Array): Uint8Array {
  observeSecretBuffer?.(buf);
  return buf;
}

export function wipe(...bufs: (Uint8Array | null | undefined)[]): void {
  for (const b of bufs) b?.fill(0);
}

export class PasskeyEoaDerivationError extends Error {}

/**
 * HKDF-SHA256(ikm = PRF output, salt, info) -> 32 bytes, rejected and
 * re-expanded with a counter in the (2^-128) case it is not a valid secp256k1
 * scalar. Deterministic: the same PRF output always gives the same key.
 * The caller owns the returned buffer and must wipe it.
 */
export function derivePasskeyEoaKey(prf: Uint8Array): Uint8Array {
  if (prf.length !== 32) throw new PasskeyEoaDerivationError('Passkey returned an unexpected secret length.');
  const salt = utf8(PASSKEY_EOA_HKDF_SALT_LABEL);
  const prk = track(extract(sha256, prf, salt));
  try {
    for (let counter = 0; counter < 256; counter++) {
      const base = utf8(PASSKEY_EOA_HKDF_INFO_LABEL);
      const info = counter === 0 ? base : new Uint8Array([...base, counter]);
      const okm = track(expand(sha256, prk, info, 32));
      if (secp256k1.utils.isValidSecretKey(okm)) return okm;
      wipe(okm);
    }
    throw new PasskeyEoaDerivationError('Could not derive a signing key from this passkey.');
  } finally {
    wipe(prk);
  }
}

/** Public address of a key. Allocates only public bytes besides the key itself. */
export function passkeyEoaAddressFromKey(key: Uint8Array): Address {
  const pub = secp256k1.getPublicKey(key, false);
  const hash = keccak_256(pub.subarray(1));
  let hex = '0x';
  for (const b of hash.subarray(12)) hex += b.toString(16).padStart(2, '0');
  return getAddress(hex);
}

/**
 * The only way to use the key: derive it from `prf`, hand it to `fn` for the
 * duration of the call, then zero the key AND the PRF output whatever
 * happens. `fn` must not keep the buffer.
 */
export async function withPasskeyEoaKey<T>(prf: Uint8Array, fn: (key: Uint8Array) => T | Promise<T>): Promise<T> {
  track(prf);
  let key: Uint8Array | null = null;
  try {
    key = derivePasskeyEoaKey(prf);
    return await fn(key);
  } finally {
    wipe(key, prf);
    key = null;
  }
}

/**
 * ECDSA over a 32-byte digest (no prehash), low-s, RFC 6979 deterministic.
 * Returns the public signature parts; the digest copy is wiped.
 */
export function signDigestWithKey(key: Uint8Array, digest: Uint8Array): { r: bigint; s: bigint; yParity: 0 | 1 } {
  if (digest.length !== 32) throw new PasskeyEoaDerivationError('Expected a 32-byte digest.');
  const d = track(new Uint8Array(digest));
  try {
    const bytes = secp256k1.sign(d, key, { prehash: false, lowS: true, format: 'recovered' });
    const sig = secp256k1.Signature.fromBytes(bytes, 'recovered');
    const recovery = sig.recovery;
    if (recovery !== 0 && recovery !== 1) throw new PasskeyEoaDerivationError('Unexpected signature recovery id.');
    return { r: sig.r, s: sig.s, yParity: recovery };
  } finally {
    wipe(d);
  }
}
