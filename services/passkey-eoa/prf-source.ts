// Web (and type-check) build: the passkey EOA is a native-app feature. The web
// keeps its own passkey flow (services/passkey.ts) and nothing changes there.
// Metro resolves prf-source.native.ts on iOS and Android.

import { PasskeyEoaError } from './errors';

export type PrfGrant = { prf: Uint8Array; credentialId: string | null };

export function isPasskeyEoaSupported(): boolean {
  return false;
}

export async function requestPasskeyEoaPrf(_credentialId?: string | null): Promise<PrfGrant> {
  throw new PasskeyEoaError('unsupported');
}

export async function createPasskeyEoaCredential(): Promise<PrfGrant> {
  throw new PasskeyEoaError('unsupported');
}
