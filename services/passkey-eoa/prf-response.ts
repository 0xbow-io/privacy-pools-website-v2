// Turn a native passkey assertion/registration result into the PRF bytes.
// Rules: see ./derivation.ts. The PRF arrives as a base64 string (the bridge
// is JSON on both platforms); it is decoded straight into a Uint8Array and
// the field is blanked on the result object so nothing keeps the string.

import { PasskeyEoaError } from './errors';

type PrfValues = { first?: unknown; second?: unknown };
export type NativePasskeyResult = {
  id?: string;
  rawId?: string;
  response?: { authenticatorData?: string; clientDataJSON?: string };
  clientExtensionResults?: { prf?: { enabled?: boolean; results?: PrfValues } };
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode base64 or base64url (padded or not) into bytes. Throws on bad input. */
export function decodeBase64Any(value: string): Uint8Array {
  const clean = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) throw new PasskeyEoaError('failed');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < clean.length; i++) {
    buffer = (buffer << 6) | B64.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (buffer >> bits) & 0xff;
    }
  }
  buffer = 0;
  return out;
}

/** UV bit (0x04) of the authenticator data flags byte at offset 32. */
export function authDataUserVerified(authData: Uint8Array): boolean {
  return authData.length >= 37 && (authData[32] & 0x04) !== 0;
}

/**
 * Extract PRF `first` (exactly 32 bytes) from a native result. Fails closed:
 * no PRF -> prf-unsupported; an assertion without UV -> not-verified.
 * `requireUv` is false only for create(), whose auth data the bridge omits.
 */
export function takePrfFromNativeResult(result: NativePasskeyResult | null | undefined, requireUv: boolean): Uint8Array {
  if (!result) throw new PasskeyEoaError('cancelled');
  if (requireUv) {
    const raw = result.response?.authenticatorData;
    const authData = typeof raw === 'string' ? decodeBase64Any(raw) : new Uint8Array(0);
    if (!authDataUserVerified(authData)) throw new PasskeyEoaError('not-verified');
  }
  const results = result.clientExtensionResults?.prf?.results;
  const first = results?.first;
  if (results) {
    // Drop the bridge's string copies as early as possible.
    results.first = undefined;
    results.second = undefined;
  }
  if (typeof first !== 'string' || first.length === 0) throw new PasskeyEoaError('prf-unsupported');
  const bytes = decodeBase64Any(first);
  if (bytes.length !== 32) {
    bytes.fill(0);
    // Some third-party managers acknowledge PRF but return an empty or short value.
    throw new PasskeyEoaError('prf-unsupported');
  }
  return bytes;
}

export function credentialIdOf(result: NativePasskeyResult | null | undefined): string | null {
  const id = result?.rawId || result?.id;
  return typeof id === 'string' && /^[A-Za-z0-9_-]+=*$/.test(id) ? id.replace(/=+$/, '') : null;
}
