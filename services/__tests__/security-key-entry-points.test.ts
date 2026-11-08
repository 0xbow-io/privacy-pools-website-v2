// The security key is offered wherever the passkey is (Pat, 2026-11-08). These
// check the two non-dialog entry points pass the choice down to WebAuthn and
// keep the same derivation: the embedded (smart) wallet on the web and the
// passkey EOA sign-in on native.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
mock.module('expo-secure-store', () => ({
  getItem: () => null,
  setItem: () => undefined,
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));

type AnyRecord = Record<string, unknown>;
// The real services/passkey.ts runs; only the browser's WebAuthn is faked.
const createCalls: AnyRecord[] = [];
const getCalls: AnyRecord[] = [];
let createPrfEnabled = true;
let getThrows: Error | null = null;
const PRF_BYTES = new Uint8Array(32).fill(0x11);
const AUTH_DATA = (() => { const a = new Uint8Array(37); a[32] = 0x05; return a; })();
function credential(withPrf: boolean) {
  return {
    rawId: new Uint8Array([9, 9, 9]).buffer,
    response: {
      authenticatorData: AUTH_DATA.buffer,
      getTransports: () => ['usb'],
      getAuthenticatorData: () => AUTH_DATA.buffer,
    },
    getClientExtensionResults: () => (withPrf ? { prf: { enabled: true, results: { first: PRF_BYTES } } } : { prf: { enabled: createPrfEnabled } }),
  };
}

const store = new Map<string, string>();
const g = globalThis as AnyRecord;
const saved = { window: g.window, navigator: g.navigator };
g.window = {
  location: { hostname: 'privacypools.com' },
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  PublicKeyCredential: Object.assign(function PublicKeyCredential() {}, { isUserVerifyingPlatformAuthenticatorAvailable: async () => true }),
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    credentials: {
      // create() returns no PRF (as security keys do), so a follow-up get() is needed.
      create: async (o: { publicKey: AnyRecord }) => { createCalls.push(o.publicKey); return credential(false); },
      get: async (o: { publicKey: AnyRecord }) => {
        getCalls.push(o.publicKey);
        if (getThrows) throw getThrows;
        return credential(true);
      },
    },
  },
});
afterAll(() => {
  g.window = saved.window;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: saved.navigator });
});

const { createWallet, unlockWallet, recoverWallet } = await import('../embedded-wallet/account');
const { passkeyEoaSignIn } = await import('../passkey-eoa/sign-in');
const { PasskeyCancelledError } = await import('../passkey');
const sel = (o: AnyRecord) => o.authenticatorSelection as AnyRecord;
const allow = (o: AnyRecord) => o.allowCredentials as { transports?: string[] }[] | undefined;

beforeEach(() => {
  createCalls.length = 0;
  getCalls.length = 0;
  createPrfEnabled = true;
  getThrows = null;
  store.clear();
});

describe('embedded wallet: security key next to the passkey', () => {
  test('device passkey create is unchanged (no attachment, no hint)', async () => {
    createPrfEnabled = true;
    await createWallet();
    expect(sel(createCalls[0]).authenticatorAttachment).toBeUndefined();
    expect(createCalls[0].hints).toBeUndefined();
    expect((createCalls[0].user as AnyRecord).name).toBe('Privacy Pools Wallet');
  });
  test('security key create asks for a roaming key, records it, and unlock targets it', async () => {
    const a = await createWallet(undefined, { authenticator: 'security-key' });
    expect(sel(createCalls[0]).authenticatorAttachment).toBe('cross-platform');
    expect(createCalls[0].hints).toEqual(['security-key']);
    expect(a.meta.passkey?.kind).toBe('security-key');
    expect(a.meta.passkey?.transports).toEqual(['usb']);
    // PRF came from the follow-up assertion, targeted at the new credential.
    expect(allow(getCalls[0])?.[0]?.transports).toEqual(['usb']);
    expect(getCalls[0].hints).toEqual(['security-key']);
    const b = await unlockWallet();
    expect(allow(getCalls[1])?.length).toBe(1);
    expect(getCalls[1].hints).toEqual(['security-key']);
    // Same PRF, same EOA: the derivation does not depend on the authenticator.
    expect(b.meta.address).toBe(a.meta.address);
    const p = await createWallet();
    expect(p.meta.address).toBe(a.meta.address);
  });
  test('a key without PRF (no hmac-secret) fails clearly and records nothing', async () => {
    createPrfEnabled = false;
    await expect(createWallet(undefined, { authenticator: 'security-key' })).rejects.toThrow('SECURITY_KEY_PRF_UNSUPPORTED');
    expect(store.size).toBe(0);
  });
  test('recover with a security key is a discoverable sign-in steered to keys', async () => {
    const r = await recoverWallet({ authenticator: 'security-key' });
    expect(getCalls[0].allowCredentials).toBeUndefined();
    expect(getCalls[0].hints).toEqual(['security-key']);
    expect(r.meta.passkey?.kind).toBe('security-key');
    getThrows = Object.assign(new Error('no'), { name: 'NotAllowedError' });
    await expect(recoverWallet({ authenticator: 'security-key' })).rejects.toThrow('SECURITY_KEY_NOT_FOUND');
    expect(PasskeyCancelledError).toBeDefined();
  });
});

describe('native passkey EOA sign-in: the authenticator reaches the prompt', () => {
  const grant = () => ({ prf: new Uint8Array(32).fill(3), credentialId: 'k' });
  test('create and existing both pass the security-key choice through', async () => {
    const seen: unknown[] = [];
    const prompts = {
      request: async (_id: string | null, kind?: string) => { seen.push(['request', kind]); return grant(); },
      create: async (kind?: string) => { seen.push(['create', kind]); return grant(); },
    };
    await passkeyEoaSignIn(prompts, 'create', null, 'security-key');
    await passkeyEoaSignIn(prompts, 'existing', null, 'security-key');
    await passkeyEoaSignIn(prompts, 'existing', null);
    expect(seen).toEqual([['create', 'security-key'], ['request', 'security-key'], ['request', 'platform']]);
  });
});
