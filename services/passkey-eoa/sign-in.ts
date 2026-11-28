// Sign in = learn the passkey EOA's public address. Rules: see ./derivation.ts.
// One prompt (two when a new passkey's platform only gives PRF on assertion);
// the key exists only inside withPasskeyEoaKey for the address computation.

import type { Address } from 'viem';

import { passkeyEoaAddressFromKey, withPasskeyEoaKey } from './derivation';
import { PasskeyEoaError } from './errors';
import type { PasskeyEoaAuthenticator, PrfGrant } from './prf-source';
import type { PasskeyEoaRecord } from './store';

export type PasskeyPrompts = {
  request: (credentialId: string | null, authenticator?: PasskeyEoaAuthenticator) => Promise<PrfGrant>;
  create: (authenticator?: PasskeyEoaAuthenticator) => Promise<PrfGrant>;
};

async function recordFromGrant(grant: PrfGrant): Promise<PasskeyEoaRecord> {
  const address: Address = await withPasskeyEoaKey(grant.prf, (key) => passkeyEoaAddressFromKey(key));
  return { address, credentialId: grant.credentialId };
}

/**
 * `existing`: an assertion with the privacypools.com passkey (the stored
 * credential first, then any discoverable one if that was deleted).
 * `create`: a new passkey, then its address.
 */
export async function passkeyEoaSignIn(
  prompts: PasskeyPrompts,
  mode: 'existing' | 'create',
  knownCredentialId: string | null,
  authenticator: PasskeyEoaAuthenticator = 'platform',
): Promise<PasskeyEoaRecord> {
  if (mode === 'create') return recordFromGrant(await prompts.create(authenticator));
  try {
    return await recordFromGrant(await prompts.request(knownCredentialId, authenticator));
  } catch (e) {
    if (knownCredentialId && e instanceof PasskeyEoaError && e.failure === 'no-passkey') {
      return recordFromGrant(await prompts.request(null, authenticator));
    }
    throw e;
  }
}
