// Picking the authenticator that unlocks a wallet's private account: the
// device passkey (platform authenticator) or a security key (a FIDO2 roaming
// authenticator such as a YubiKey). Pure rules only, so they are testable
// without a browser. The WebAuthn calls live in services/passkey.ts and the
// unlock flow in components/sdk-provider.tsx.
//
// What does NOT change here: the account is still derived from the WebAuthn
// PRF output exactly as before (services/passkey-derivation.ts). A security key
// is just another authenticator that answers the same PRF request through its
// CTAP2 hmac-secret extension, so nobody's existing account moves.

import { sha256 } from '@noble/hashes/sha2.js';

export type PasskeyAuthenticatorKind = 'platform' | 'security-key';

/** WebAuthn L3 transports a credential reported at registration. */
export const KNOWN_TRANSPORTS = ['usb', 'nfc', 'ble', 'hybrid', 'internal', 'smart-card'] as const;

/**
 * May the user switch THIS wallet's unlock to a passkey or security key?
 * A security key has exactly the passkey's gate (Pat, 2026-11-08: offered
 * wherever the passkey is, as the alternative next to it), so `kind` never
 * changes the answer:
 *
 * - a smart-contract wallet: its unlock is the passkey by construction;
 * - a wallet that proved it signs non-deterministically: the signature path
 *   is a dead end for it;
 * - a wallet that this browser already unlocked with a passkey or key: the
 *   recorded credential decides the kind, so a returning user does not have to
 *   fail the signature check again on every page load.
 *
 * Any other wallet keeps the wallet signature and sees neither.
 */
export function mayChoosePasskeyUnlock(input: {
  kind: PasskeyAuthenticatorKind;
  signerRefused: boolean;
  hasRecordedPasskey: boolean;
  isSmartWallet: boolean;
}): boolean {
  return input.isSmartWallet || input.signerRefused || input.hasRecordedPasskey;
}

const OWNER_TAG_DOMAIN = 'ppv2-security-key-user:v1';
export const OWNER_TAG_BYTES = 16;
export const USER_HANDLE_BYTES = 32;

/**
 * 16 bytes that identify the owner a security-key credential was made for:
 * SHA-256(domain | rpId | owner)[0..16]. Public data in, nothing secret out.
 */
export function securityKeyOwnerTag(ownerAddress: string, rpId: string): Uint8Array {
  const input = new TextEncoder().encode(`${OWNER_TAG_DOMAIN}|${rpId.toLowerCase()}|${ownerAddress.toLowerCase()}`);
  return sha256(input).slice(0, OWNER_TAG_BYTES);
}

/**
 * The WebAuthn user.id for a new security-key credential: the owner tag
 * followed by 16 random bytes.
 *
 * The tag makes the credential recognisable: an assertion returns it as the
 * userHandle, so a key found by a discoverable sign-in on a new browser is
 * checked against the connected wallet before its PRF is used.
 *
 * The random half is deliberate. A FIDO2 authenticator OVERWRITES a
 * discoverable credential that has the same RP ID and user.id. A fully
 * deterministic user.id would let a second setup on the same key destroy the
 * first credential, and with it the PRF the account is derived from. Duplicate
 * credentials are prevented by looking for the existing one first (discoverable
 * sign-in, then allowCredentials) instead.
 */
export function securityKeyUserId(ownerAddress: string, rpId: string, random16: Uint8Array): Uint8Array {
  if (random16.length !== USER_HANDLE_BYTES - OWNER_TAG_BYTES) {
    throw new Error(`securityKeyUserId expects ${USER_HANDLE_BYTES - OWNER_TAG_BYTES} random bytes`);
  }
  const out = new Uint8Array(USER_HANDLE_BYTES);
  out.set(securityKeyOwnerTag(ownerAddress, rpId), 0);
  out.set(random16, OWNER_TAG_BYTES);
  return out;
}

/**
 * What a discoverable sign-in found: a credential made for this owner, one
 * made for another owner, or one with no owner tag (made before tags existed,
 * or by another flow), which cannot be attributed and is never used blindly.
 */
export function classifyUserHandle(
  userHandle: Uint8Array | null | undefined,
  ownerAddress: string,
  rpId: string,
): 'owner' | 'other-owner' | 'untagged' {
  if (!userHandle || userHandle.length !== USER_HANDLE_BYTES) return 'untagged';
  return userHandleMatchesOwner(userHandle, ownerAddress, rpId) ? 'owner' : 'other-owner';
}

/** Does an assertion's userHandle say it was made for this owner? */
export function userHandleMatchesOwner(userHandle: Uint8Array | null | undefined, ownerAddress: string, rpId: string): boolean {
  if (!userHandle || userHandle.length !== USER_HANDLE_BYTES) return false;
  const tag = securityKeyOwnerTag(ownerAddress, rpId);
  let diff = 0;
  for (let i = 0; i < OWNER_TAG_BYTES; i++) diff |= tag[i] ^ userHandle[i];
  return diff === 0;
}

/**
 * user.name / displayName shown by the browser and the key's own credential
 * list, so two wallets' entries on one key can be told apart. The short
 * address stays on the user's own hardware key. Device passkeys keep the
 * generic name: they sync to a cloud account.
 */
export function securityKeyUserName(ownerAddress: string): string {
  const a = ownerAddress.toLowerCase();
  const short = /^0x[0-9a-f]{40}$/.test(a) ? `${a.slice(0, 6)}...${a.slice(-4)}` : 'wallet';
  return `Privacy Pools ${short}`;
}

/** Keeps only transports WebAuthn defines, so a stored value cannot inject anything else. */
export function sanitizeTransports(raw: unknown): AuthenticatorTransport[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set<string>(KNOWN_TRANSPORTS);
  const out: AuthenticatorTransport[] = [];
  for (const t of raw) if (typeof t === 'string' && allowed.has(t) && !out.includes(t as AuthenticatorTransport)) out.push(t as AuthenticatorTransport);
  return out;
}

/** Stored next to the credential id (localStorage, public data only). */
export type PasskeyMarkerMeta = { kind: PasskeyAuthenticatorKind; transports: AuthenticatorTransport[] };

export function encodeMarkerMeta(meta: PasskeyMarkerMeta): string {
  return JSON.stringify({ v: 1, kind: meta.kind, transports: sanitizeTransports(meta.transports) });
}

/** Unknown, missing or malformed metadata reads as a device passkey: what every marker before this change was. */
export function decodeMarkerMeta(raw: string | null | undefined): PasskeyMarkerMeta {
  if (!raw) return { kind: 'platform', transports: [] };
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown; transports?: unknown };
    const kind: PasskeyAuthenticatorKind = parsed?.kind === 'security-key' ? 'security-key' : 'platform';
    return { kind, transports: sanitizeTransports(parsed?.transports) };
  } catch {
    return { kind: 'platform', transports: [] };
  }
}

export const SECURITY_KEY_NOT_FOUND_MESSAGE = 'No Privacy Pools sign-in found on that key for this wallet. Try again, or set up this key.';
export const SECURITY_KEY_PROMPT_CLOSED_MESSAGE = 'The security key prompt was closed or timed out. Tap Sign in to try again.';
export const SECURITY_KEY_CONFIRM_CREATE_MESSAGE = 'No sign-in for this wallet was found on that key. Create one only if this key was never used with this wallet.';
export const SECURITY_KEY_OTHER_WALLET_MESSAGE = 'That security key is set up for another wallet. Connect that wallet, or set up this key.';
export const SECURITY_KEY_UNTAGGED_MESSAGE = 'That key was set up in another browser. Unlock it there, or set up this key.';
export const SECURITY_KEY_NO_PRF_MESSAGE = 'This browser or key cannot unlock Privacy Pools. Use a key with hmac-secret, like a YubiKey 5, in a current Chrome, Edge or Firefox.';

/**
 * WebAuthn answers NotAllowedError both when the user closes the prompt and
 * when the key holds no credential for this site: the spec hides which, on
 * purpose. So a failed look-up can never be read as "this key is empty".
 *
 * - find (Sign in): any closed, cancelled or timed-out prompt is just that.
 *   Never a reason to create: on a key that already holds this wallet's
 *   credential, a second one would be a different, empty account.
 * - check (inside "Set up a new key", which the user chose on purpose): a
 *   closed prompt asks for an explicit second confirmation before anything is
 *   created, and a timeout (nobody touched the key) stops.
 */
export type SecurityKeyLookupOutcome = 'closed' | 'confirm-create';
export function securityKeyLookupOutcome(input: {
  stage: 'find' | 'check';
  elapsedMs: number;
  timeoutMs: number;
}): SecurityKeyLookupOutcome {
  if (input.stage === 'find') return 'closed';
  // Within 5 s of the ceremony timeout counts as a timeout.
  if (input.elapsedMs >= input.timeoutMs - 5_000) return 'closed';
  return 'confirm-create';
}

/** The look-up prompt was closed or timed out. Nothing is created. */
export class SecurityKeyPromptClosedError extends Error {
  constructor(message = SECURITY_KEY_PROMPT_CLOSED_MESSAGE) {
    super(message);
    this.name = 'SecurityKeyPromptClosedError';
  }
}

/** The user asked to set up a key and the check found nothing: create only on a second, explicit tap. */
export class SecurityKeyConfirmCreateError extends Error {
  constructor(message = SECURITY_KEY_CONFIRM_CREATE_MESSAGE) {
    super(message);
    this.name = 'SecurityKeyConfirmCreateError';
  }
}

/** A completed sign-in returned a credential that is not this wallet's. Nothing is created. */
export class SecurityKeyNotFoundError extends Error {
  constructor(message = SECURITY_KEY_NOT_FOUND_MESSAGE) {
    super(message);
    this.name = 'SecurityKeyNotFoundError';
  }
}

/** The browser or the key cannot produce the PRF output the account is derived from. */
export class SecurityKeyPrfUnsupportedError extends Error {
  constructor(message = SECURITY_KEY_NO_PRF_MESSAGE) {
    super(message);
    this.name = 'SecurityKeyPrfUnsupportedError';
  }
}
