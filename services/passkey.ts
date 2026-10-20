// Passkey (WebAuthn) + PRF foundation for Privacy Pools key derivation.
//
// SCOPE / STATUS: this module is the architecture-agnostic plumbing only. It
// produces the WebAuthn PRF bytes and reports backup state; it does NOT decide
// what those bytes mean. Turning the PRF output into protocol keys lives in the
// SDK (`deriveKeysFromSecret`, not yet built) and is gated on freezing the root
// contract (see plans/007). Nothing here persists key material.
//
// Design notes baked in (per the agreed direction):
//   - Single-device model: we do NOT try to make accounts roam across devices /
//     ecosystems. The passkey is a device-local unlock; a passkey-gated
//     downloadable backup is the deliberate move/recover path.
//   - Discoverable (resident) credentials so a fresh page load can find the
//     credential without us storing a credential id in a backend.
//   - PRF requested at create AND obtainable on assert (some platforms only
//     return usable PRF output on assertion — never assume create() suffices).
//   - We surface the WebAuthn BE/BS flags so the UI can detect whether the
//     passkey is backed up to the user's provider and nudge a download only
//     when it is not (see the backup model in plans/007 §0/§12).

import { Platform } from 'react-native';

// The ambient DOM lib already ships the WebAuthn PRF extension types
// (`AuthenticationExtensionsClientInputs.prf` etc.), so we use those directly.
// The only friction is TS 5.7's generic `Uint8Array<ArrayBufferLike>` vs the
// `BufferSource` (`ArrayBufferView<ArrayBuffer>`) the WebAuthn fields want — we
// take `Uint8Array` from callers and cast to `BufferSource` at the API boundary
// (safe: a Uint8Array is a valid BufferSource at runtime).

// --- Public shapes ---------------------------------------------------------

export type BackupFlags = {
  /** UP — user present (touched the authenticator). */
  userPresent: boolean;
  /** UV — user verified (biometric / PIN). */
  userVerified: boolean;
  /** BE — credential is eligible for provider sync (multi-device passkey). */
  backupEligible: boolean;
  /** BS — credential is currently backed up to the provider's cloud. */
  backupState: boolean;
};

export type PrfResult = {
  /** base64url credential id — discoverable, so callers usually don't need it. */
  credentialId: string;
  /** The PRF outputs as 0x-hex. `second` is present only if a second salt was requested. */
  prf: { first: `0x${string}`; second?: `0x${string}` };
  /** Backup/UV flags read from the authenticator data of this assertion. */
  flags: BackupFlags;
};

export type CreateResult = {
  credentialId: string;
  /** PRF at create() — undefined when the platform only returns PRF on assert. */
  prf?: { first: `0x${string}`; second?: `0x${string}` };
  flags: BackupFlags;
  /** PRF extension acknowledged at create (`prf.enabled` or a result present).
   * If false, this credential likely does NOT support PRF — confirm with a
   * follow-up assertion before treating it as a usable passkey account. */
  prfEnabled: boolean;
  /** Whether BE/BS/UV flags could be read at create. Some browsers don't expose
   * registration authenticator data; when false, `flags` is not authoritative —
   * use a getPasskeyPrf() assertion (flags are always present there). */
  flagsKnown: boolean;
};

export class PasskeyUnsupportedError extends Error {}
export class PasskeyCancelledError extends Error {}
export class PasskeyUserVerificationError extends Error {}
export class PrfUnavailableError extends Error {}

// --- Salts -----------------------------------------------------------------
//
// SPIKE salts — placeholders for the foundation. The REAL protocol salts get
// frozen together with the root contract (plans/007 decision gate) and must
// never change afterward, or every account's keys change. The WebAuthn layer
// internally domain-separates these as SHA-256("WebAuthn PRF"\0 || salt), so we
// just pass raw, stable bytes.
const SPIKE_IDENTITY_SALT = utf8('ppv2-spike:identity:v0');
const SPIKE_REVOCABLE_SALT = utf8('ppv2-spike:revocable:v0:epoch0');

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// --- Capability detection --------------------------------------------------

export function isWebAuthnAvailable(): boolean {
  return (
    Platform.OS === 'web' &&
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials
  );
}

/**
 * Best-effort PRF support probe. There is no synchronous capability query for
 * the PRF extension, so this only confirms WebAuthn + platform-authenticator
 * availability; the authoritative signal is `prf.enabled` / a non-empty
 * `prf.results` on an actual create()/get(). Callers must still handle
 * PrfUnavailableError at runtime and fall back to the seed path.
 */
export async function isPasskeyPrfLikelySupported(): Promise<boolean> {
  if (!isWebAuthnAvailable()) return false;
  try {
    const uvpaa =
      await window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.();
    return uvpaa !== false; // unknown/true → proceed and verify at runtime
  } catch {
    return false;
  }
}

// --- Create ----------------------------------------------------------------

export async function createPasskey(opts: {
  rpId: string;
  rpName: string;
  userId: Uint8Array;
  userName: string;
  userDisplayName: string;
  challenge: Uint8Array;
}): Promise<CreateResult> {
  if (!isWebAuthnAvailable()) throw new PasskeyUnsupportedError('WebAuthn is unavailable here.');

  const publicKey: PublicKeyCredentialCreationOptions = {
    rp: { id: opts.rpId, name: opts.rpName },
    user: { id: opts.userId as BufferSource, name: opts.userName, displayName: opts.userDisplayName },
    challenge: opts.challenge as BufferSource,
    // ES256 (-7) then RS256 (-257) for the widest authenticator coverage.
    pubKeyCredParams: [
      { type: 'public-key', alg: -7 },
      { type: 'public-key', alg: -257 },
    ],
    authenticatorSelection: {
      residentKey: 'required', // discoverable. Find it on a fresh page with no stored id
      requireResidentKey: true,
      userVerification: 'required', // biometric / PIN
    },
    timeout: 120_000,
    extensions: {
      prf: {
        eval: {
          first: SPIKE_IDENTITY_SALT as BufferSource,
          second: SPIKE_REVOCABLE_SALT as BufferSource,
        },
      },
    },
  };

  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  } catch (e) {
    throw toPasskeyError(e);
  }
  if (!cred) throw new PasskeyCancelledError('Passkey creation returned no credential.');

  const attestation = cred.response as AuthenticatorAttestationResponse;
  const authData = getRegistrationAuthData(attestation);
  const flags = authData ? parseAuthDataFlags(authData) : EMPTY_FLAGS;
  const ext = cred.getClientExtensionResults() as AuthenticationExtensionsClientOutputs;
  const prf = extractPrf(ext);
  const prfEnabled = ext.prf?.enabled === true || !!prf;

  return {
    credentialId: toBase64Url(new Uint8Array(cred.rawId)),
    prf,
    flags,
    prfEnabled,
    flagsKnown: authData !== null,
  };
}

// --- Assert / get PRF ------------------------------------------------------

export async function getPasskeyPrf(opts: {
  rpId: string;
  challenge: Uint8Array;
  /** Optional: restrict to a known credential id (base64url). Omit for discoverable. */
  credentialId?: string;
}): Promise<PrfResult> {
  if (!isWebAuthnAvailable()) throw new PasskeyUnsupportedError('WebAuthn is unavailable here.');

  const allowCredentials: PublicKeyCredentialDescriptor[] | undefined = opts.credentialId
    ? [{ type: 'public-key', id: fromBase64Url(opts.credentialId) as BufferSource }]
    : undefined; // undefined/empty → discoverable

  const publicKey: PublicKeyCredentialRequestOptions = {
    rpId: opts.rpId,
    challenge: opts.challenge as BufferSource,
    userVerification: 'required',
    timeout: 120_000,
    allowCredentials,
    extensions: {
      prf: {
        eval: {
          first: SPIKE_IDENTITY_SALT as BufferSource,
          second: SPIKE_REVOCABLE_SALT as BufferSource,
        },
      },
    },
  };

  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  } catch (e) {
    throw toPasskeyError(e);
  }
  if (!cred) throw new PasskeyCancelledError('Passkey assertion returned no credential.');

  const assertion = cred.response as AuthenticatorAssertionResponse;
  const authData = new Uint8Array(assertion.authenticatorData);
  const flags = parseAuthDataFlags(authData);
  // Fail closed: this PRF output is spend-grade and (for the backup export)
  // must come from a fresh user-verified gesture. Refuse to release it if the
  // authenticator data is malformed or user verification was not performed,
  // regardless of what the request asked for.
  if (authData.length < 37 || !flags.userVerified) {
    throw new PasskeyUserVerificationError(
      'Passkey assertion was not user-verified; refusing to release key material.',
    );
  }
  const prf = extractPrf(cred.getClientExtensionResults());
  if (!prf) {
    throw new PrfUnavailableError(
      'This passkey did not return the data needed to unlock your account. Try again, or use another passkey on this device.',
    );
  }

  return { credentialId: toBase64Url(new Uint8Array(cred.rawId)), prf, flags };
}

// --- Auth-data flag parsing ------------------------------------------------

const EMPTY_FLAGS: BackupFlags = {
  userPresent: false,
  userVerified: false,
  backupEligible: false,
  backupState: false,
};

/**
 * Authenticator data layout: rpIdHash(32) || flags(1) || signCount(4) || ...
 * Flag bits: UP 0x01, UV 0x04, BE 0x08, BS 0x10, AT 0x40, ED 0x80.
 */
export function parseAuthDataFlags(authData: Uint8Array): BackupFlags {
  if (authData.length < 33) return EMPTY_FLAGS;
  const f = authData[32];
  return {
    userPresent: (f & 0x01) !== 0,
    userVerified: (f & 0x04) !== 0,
    backupEligible: (f & 0x08) !== 0,
    backupState: (f & 0x10) !== 0,
  };
}

// Registration authData: prefer getAuthenticatorData() (Level 3), else parse
// it out of the CBOR attestationObject (authData follows the map; we locate it
// via the rpIdHash + flags + counter being at a fixed tail offset is not safe,
// so we only use the helper and degrade to empty flags if absent).
function getRegistrationAuthData(res: AuthenticatorAttestationResponse): Uint8Array | null {
  const maybe = (res as unknown as { getAuthenticatorData?: () => ArrayBuffer }).getAuthenticatorData;
  if (typeof maybe === 'function') {
    try {
      return new Uint8Array(maybe.call(res));
    } catch {
      return null;
    }
  }
  return null;
}

// --- helpers ---------------------------------------------------------------

function extractPrf(
  ext: AuthenticationExtensionsClientOutputs,
): { first: `0x${string}`; second?: `0x${string}` } | undefined {
  const r = ext.prf?.results;
  if (!r?.first) return undefined;
  // Some providers (e.g. the 1Password extension) acknowledge the PRF extension
  // but return an empty result. A usable PRF secret is exactly 32 bytes; treat
  // anything else as "no PRF" so the caller falls back cleanly instead of
  // deriving keys from a 0-byte secret (which throws a raw error downstream).
  const firstBytes = bufferSourceToBytes(r.first);
  if (firstBytes.length !== 32) return undefined;
  const out: { first: `0x${string}`; second?: `0x${string}` } = {
    first: toHex(firstBytes),
  };
  if (r.second) out.second = toHex(bufferSourceToBytes(r.second));
  return out;
}

function bufferSourceToBytes(src: BufferSource): Uint8Array {
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
}

function toHex(bytes: Uint8Array): `0x${string}` {
  let s = '0x';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s as `0x${string}`;
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  const norm = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm.padEnd(Math.ceil(norm.length / 4) * 4, '=');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toPasskeyError(e: unknown): Error {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return new PasskeyCancelledError('Passkey prompt was dismissed or timed out.');
  }
  return e instanceof Error ? e : new Error(String(e));
}
