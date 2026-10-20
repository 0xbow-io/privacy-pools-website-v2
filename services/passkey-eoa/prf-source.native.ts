// Native passkey prompt for the EOA PRF (react-native-passkey: Android Credential
// Manager, iOS 18+ AuthenticationServices). Rules: see ./derivation.ts.
//
// RP ID is the apex privacypools.com, so the app sees the SAME passkeys as the
// web (services/passkey-rp-id.ts). That needs the domain association files
// (docs/passkey-app-association.md). The PRF salt is passed as bytes, not
// base64url: the library base64url-encodes it for Android, and iOS decodes
// only the byte form (a string salt fails to decode there). Both
// platforms apply the WebAuthn SHA-256("WebAuthn PRF" || 0x00 || salt) step
// themselves, as browsers do.

import { Passkey, type PasskeyGetResult, type PasskeyCreateResult } from 'react-native-passkey';

import { PASSKEY_APEX_DOMAIN } from '@/services/passkey-rp-id';
import { passkeyEoaPrfSalt } from './derivation';
import { PasskeyEoaError, classifyNativePasskeyError } from './errors';
import { credentialIdOf, takePrfFromNativeResult, type NativePasskeyResult } from './prf-response';

export type PrfGrant = { prf: Uint8Array; credentialId: string | null };

const TIMEOUT_MS = 120_000;

function randomBase64Url(n: number): string {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function isPasskeyEoaSupported(): boolean {
  try {
    return Passkey.isSupported();
  } catch {
    return false;
  }
}

/** One passkey prompt. The caller owns `prf` and must wipe it (withPasskeyEoaKey does). */
export async function requestPasskeyEoaPrf(credentialId?: string | null): Promise<PrfGrant> {
  if (!isPasskeyEoaSupported()) throw new PasskeyEoaError('unsupported');
  let result: PasskeyGetResult;
  try {
    result = await Passkey.get({
      rpId: PASSKEY_APEX_DOMAIN,
      // No server verifies this assertion: only the PRF is used, so a local
      // random challenge is enough (as on the web).
      challenge: randomBase64Url(32),
      userVerification: 'required',
      timeout: TIMEOUT_MS,
      ...(credentialId ? { allowCredentials: [{ type: 'public-key' as const, id: credentialId }] } : {}),
      extensions: { prf: { eval: { first: passkeyEoaPrfSalt() } } },
    });
  } catch (e) {
    throw new PasskeyEoaError(classifyNativePasskeyError(e));
  }
  const native = result as unknown as NativePasskeyResult;
  const prf = takePrfFromNativeResult(native, true);
  return { prf, credentialId: credentialIdOf(native) };
}

/**
 * Create a discoverable privacypools.com passkey. Returns its PRF when the
 * platform evaluates PRF at create, else asks once more with a get().
 */
export async function createPasskeyEoaCredential(): Promise<PrfGrant> {
  if (!isPasskeyEoaSupported()) throw new PasskeyEoaError('unsupported');
  let created: PasskeyCreateResult;
  try {
    created = await Passkey.create({
      challenge: randomBase64Url(32),
      rp: { id: PASSKEY_APEX_DOMAIN, name: 'Privacy Pools' },
      user: { id: randomBase64Url(16), name: 'privacy-pools', displayName: 'Privacy Pools' },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none',
      timeout: TIMEOUT_MS,
      extensions: { prf: { eval: { first: passkeyEoaPrfSalt() } } },
    });
  } catch (e) {
    throw new PasskeyEoaError(classifyNativePasskeyError(e));
  }
  const native = created as unknown as NativePasskeyResult;
  const credentialId = credentialIdOf(native);
  if (native.clientExtensionResults?.prf?.enabled === false) throw new PasskeyEoaError('prf-unsupported');
  try {
    return { prf: takePrfFromNativeResult(native, false), credentialId };
  } catch (e) {
    if (!(e instanceof PasskeyEoaError) || e.failure !== 'prf-unsupported') throw e;
    // This platform only evaluates PRF on assertion: ask the new passkey once.
    return requestPasskeyEoaPrf(credentialId);
  }
}
