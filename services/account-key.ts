import { sha256 } from '@noble/hashes/sha2.js';
import type { Address, Hex } from '@/services/sdk-types';

/**
 * Account-key codec: the portable sign-in secret for wallet-less sessions.
 *
 * The pool keys derive deterministically from an EIP-712 wallet signature
 * (SDK two-stage HKDF over the signature's r value), so the signature IS the
 * account: anyone holding it can rebuild the viewing/nullifying/revocable
 * keys and operate the shielded balance through the relayer — no wallet
 * connection required. Wallets registered under the pre-cutover keccak
 * scheme need the second (legacy) signature too, so the payload carries it
 * when it was captured at export time.
 *
 * This is a SPEND-GRADE secret. It is only ever shown in the export modal
 * and read back in the sign-in inputs; nothing here logs or persists it.
 */

export type AccountKeyPayload = {
  kind: 'ppv2-account-key';
  v: 1;
  /** The wallet address that owns the notes (session ownerAddress). */
  address: Address;
  /** EIP-712 secret-derivation signature (canonical HKDF scheme). */
  signature: Hex;
  /** Pre-cutover keccak-scheme signature, when the wallet needed one. */
  legacySignature?: Hex;
};

export type AccountKeyIdentity = {
  address: Address;
  signature: Hex;
  legacySignature?: Hex;
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;

function toBase64(value: string): string {
  if (typeof btoa === 'function') return btoa(value);
  return Buffer.from(value, 'utf8').toString('base64');
}

function fromBase64(value: string): string {
  if (typeof atob === 'function') return atob(value);
  return Buffer.from(value, 'base64').toString('utf8');
}

export function encodeAccountKey(identity: AccountKeyIdentity): string {
  const payload: AccountKeyPayload = {
    kind: 'ppv2-account-key',
    v: 1,
    address: identity.address,
    signature: identity.signature,
    ...(identity.legacySignature ? { legacySignature: identity.legacySignature } : {}),
  };
  return toBase64(JSON.stringify(payload));
}

/** Decode + validate; throws with a user-facing message on bad input. */
export function decodeAccountKey(encoded: string): AccountKeyIdentity {
  let parsed: Partial<AccountKeyPayload>;
  try {
    parsed = JSON.parse(fromBase64(encoded.trim())) as Partial<AccountKeyPayload>;
  } catch {
    throw new Error('That does not look like an account key.');
  }
  if (parsed.kind !== 'ppv2-account-key' || parsed.v !== 1) {
    throw new Error('Unsupported account-key format.');
  }
  if (typeof parsed.address !== 'string' || !ADDRESS_RE.test(parsed.address)) {
    throw new Error('Account key has an invalid address.');
  }
  if (typeof parsed.signature !== 'string' || !SIGNATURE_RE.test(parsed.signature)) {
    throw new Error('Account key has an invalid signature.');
  }
  if (parsed.legacySignature !== undefined
    && (typeof parsed.legacySignature !== 'string' || !SIGNATURE_RE.test(parsed.legacySignature))) {
    throw new Error('Account key has an invalid legacy signature.');
  }
  return {
    address: parsed.address as Address,
    signature: parsed.signature as Hex,
    ...(parsed.legacySignature ? { legacySignature: parsed.legacySignature as Hex } : {}),
  };
}

/**
 * One-way id of the WHOLE identity (address + signature + legacy signature),
 * case-insensitive. Two keys for one address with different signatures derive
 * different pool keys, so the address alone does not say which key is in use.
 * A truncated SHA-256: it names the key without revealing it.
 */
export function accountKeyFingerprint(identity: AccountKeyIdentity): string {
  const material = [
    'ppv2-account-key-fp-v1',
    identity.address.toLowerCase(),
    identity.signature.toLowerCase(),
    (identity.legacySignature ?? '').toLowerCase(),
  ].join(':');
  const digest = sha256(new TextEncoder().encode(material));
  return Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
