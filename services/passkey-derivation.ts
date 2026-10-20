import { expand, extract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, toBytes } from 'viem';
import type { Hex } from 'viem';

// Exact mirror of the SDK's private `CryptoService.deriveKeys(appSecret,
// revocableKeyIndex)` tree
// (v2-monorepo/packages/sdk/src/services/CryptoService.ts:217), fed a raw
// 32-byte secret as the `appSecret`. The signature path reaches the same tree
// via two pre-stages (rootSecret = HKDF over the signature r-value salted by the
// signer address, then appSecret = HKDF over that). The passkey path SKIPS both
// pre-stages and uses the PRF output directly as the appSecret — which is what a
// future SDK `deriveKeysFromSecret(secret)` would do, so accounts derived here
// are byte-identical to that method and can swap to it later with no breakage.
//
// Constants + reduction/clamp logic are copied verbatim from the SDK
// (constant/KeyDerivation.ts, utils/KeyDerivationHelpers.ts). Equivalence with
// the SDK's own tree is checked by scripts/verify-passkey-derivation.ts. If the
// SDK ever changes these constants, regenerate that check before relying on it.
//
// FREEZE NOTE: the salts/constants below define account identity. They must not
// change once any real account is registered (the on-chain nullifying-key hash
// is write-once). For the spike the *input* salts live in services/passkey.ts;
// these protocol constants are the SDK's and are already stable there.

const PROTOCOL_SALT = 'PP_V2';
const IDENTITY_DOMAIN = 'IDENTITY';
const VIEWING_DOMAIN = 'VIEWING';
const NULLIFYING_INFO = 'NULLIFYING';
const AUTH0_REVOCABLE_PREFIX = 'AUTH0:REVOCABLE';
const VIEWING_KEY_INFO = 'VIEWING_KEY';
const BN254_SCALAR_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export type DerivedKeyMaterial = {
  privateNullifyingKey: Hex;
  privateRevocableKey: Hex;
  viewingPrivateKey: Hex;
  viewingPublicKey: Hex;
};

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

function bigintToHex(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, '0')}` as Hex;
}

function u64beCounter(n: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let val = n;
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return bytes;
}

function reduceToBN254Scalar(bytes: Uint8Array): Hex {
  return bigintToHex(bytesToBigIntBE(bytes) % BN254_SCALAR_MODULUS);
}

function clampToCurve25519(bytes: Uint8Array): Hex {
  if (bytes.length !== 32) {
    throw new Error(`clampToCurve25519 expects 32 bytes, got ${bytes.length}`);
  }
  const clamped = new Uint8Array(bytes);
  clamped[0] &= 0xf8;
  clamped[31] &= 0x7f;
  clamped[31] |= 0x40;
  const result = bigintToHex(bytesToBigIntBE(clamped));
  clamped.fill(0);
  return result;
}

/**
 * Run the SDK's HKDF derivation tree over a 32-byte secret used as the
 * `appSecret`. For passkeys, pass the WebAuthn PRF output. `revocableKeyIndex`
 * stays 0 until rotation is wired (the index-over-root model the SDK uses).
 */
export function derivePasskeyKeys(appSecret: Uint8Array, revocableKeyIndex: bigint = 0n): DerivedKeyMaterial {
  // The passkey root is always the 32-byte PRF output (or a 32-byte backup
  // root). HKDF would accept any length, but a wrong length means a caller bug
  // (and silently deriving a "valid" account from malformed input is worse than
  // failing), so guard it.
  if (appSecret.length !== 32) {
    throw new Error(`derivePasskeyKeys expects a 32-byte secret, got ${appSecret.length}`);
  }
  // Layer 1: single HKDF-Extract — appSecret as IKM, "PP_V2" as salt.
  const masterPRK = extract(sha256, appSecret, utf8(PROTOCOL_SALT));

  // Layer 2: domain PRKs.
  const identityPRK = expand(sha256, masterPRK, utf8(IDENTITY_DOMAIN), 32);
  const viewingPRK = expand(sha256, masterPRK, utf8(VIEWING_DOMAIN), 32);

  // Layer 3a: nullifying key — 48 bytes → mod BN254 p.
  const nullifyingBytes = expand(sha256, identityPRK, utf8(NULLIFYING_INFO), 48);
  const privateNullifyingKey = reduceToBN254Scalar(nullifyingBytes);

  // Layer 3b: revocable key — "AUTH0:REVOCABLE" ‖ u64be(index), 48 bytes → mod BN254 p.
  const revocableInfo = new Uint8Array([...utf8(AUTH0_REVOCABLE_PREFIX), ...u64beCounter(revocableKeyIndex)]);
  const revocableBytes = expand(sha256, identityPRK, revocableInfo, 48);
  const privateRevocableKey = reduceToBN254Scalar(revocableBytes);

  // Layer 3c: viewing key — 32 bytes → RFC 7748 clamp → X25519 scalar.
  const viewingBytes = expand(sha256, viewingPRK, utf8(VIEWING_KEY_INFO), 32);
  const viewingPrivateKey = clampToCurve25519(viewingBytes);
  const viewingPublicKey = bytesToHex(x25519.getPublicKey(hexToBytes(viewingPrivateKey))) as Hex;

  // Zeroize intermediate material.
  masterPRK.fill(0);
  identityPRK.fill(0);
  viewingPRK.fill(0);
  nullifyingBytes.fill(0);
  revocableBytes.fill(0);
  viewingBytes.fill(0);

  return { privateNullifyingKey, privateRevocableKey, viewingPrivateKey, viewingPublicKey };
}

/** Convenience: derive from a 0x-hex secret (e.g. the PRF output hex). */
export function derivePasskeyKeysFromHex(secretHex: Hex, revocableKeyIndex: bigint = 0n): DerivedKeyMaterial {
  const secret = toBytes(secretHex);
  try {
    return derivePasskeyKeys(secret, revocableKeyIndex);
  } finally {
    secret.fill(0); // don't leave the spend-grade root lingering in memory
  }
}
