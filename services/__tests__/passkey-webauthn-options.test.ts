// What services/passkey.ts actually hands navigator.credentials: the security-key
// options are new, and every existing caller (no `authenticator`) must get the
// exact request it got before.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));

const { createPasskey, getPasskeyPrf, PasskeyAlreadyRegisteredError, PasskeyCancelledError } = await import('../passkey');

type AnyRecord = Record<string, unknown>;
const g = globalThis as AnyRecord;
const saved = { window: g.window, navigator: g.navigator };
let lastCreate: AnyRecord | null = null;
let lastGet: AnyRecord | null = null;
let createImpl: () => Promise<unknown>;
let getImpl: () => Promise<unknown>;

const PRF32 = new Uint8Array(32).fill(7);
// rpIdHash(32) | flags(UP|UV) | signCount(4)
const AUTH_DATA = (() => { const a = new Uint8Array(37); a[32] = 0x05; return a; })();

function fakeCredential(extra: { userHandle?: Uint8Array; prf?: boolean } = {}) {
  return {
    rawId: new Uint8Array([1, 2, 3, 4]).buffer,
    response: {
      authenticatorData: AUTH_DATA.buffer,
      userHandle: extra.userHandle?.buffer,
      getTransports: () => ['usb', 'nfc', 'bogus'],
      getAuthenticatorData: () => AUTH_DATA.buffer,
    },
    getClientExtensionResults: () => (extra.prf === false ? {} : { prf: { enabled: true, results: { first: PRF32 } } }),
  };
}

beforeEach(() => {
  lastCreate = null;
  lastGet = null;
  createImpl = async () => fakeCredential();
  getImpl = async () => fakeCredential({ userHandle: new Uint8Array(32).fill(9) });
  g.window = { PublicKeyCredential: function PublicKeyCredential() {} };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      credentials: {
        create: async (o: { publicKey: AnyRecord }) => { lastCreate = o.publicKey; return createImpl(); },
        get: async (o: { publicKey: AnyRecord }) => { lastGet = o.publicKey; return getImpl(); },
      },
    },
  });
});

afterEach(() => {
  g.window = saved.window;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: saved.navigator });
});

const baseCreate = {
  rpId: 'privacypools.com',
  rpName: 'Privacy Pools',
  userId: new Uint8Array(16),
  userName: 'privacy-pools',
  userDisplayName: 'Privacy Pools',
  challenge: new Uint8Array(32),
};

describe('createPasskey', () => {
  test('existing callers: no attachment, no hints, no excludeCredentials', async () => {
    const res = await createPasskey(baseCreate);
    const sel = lastCreate!.authenticatorSelection as AnyRecord;
    expect(sel.authenticatorAttachment).toBeUndefined();
    expect(sel.residentKey).toBe('required');
    expect(sel.userVerification).toBe('required');
    expect(lastCreate!.hints).toBeUndefined();
    expect(lastCreate!.excludeCredentials).toBeUndefined();
    expect(res.transports).toEqual(['usb', 'nfc']);
  });
  test('security key: cross-platform, security-key hint, excludeCredentials with transports', async () => {
    await createPasskey({
      ...baseCreate,
      authenticator: 'security-key',
      excludeCredentials: [{ id: 'AQIDBA', transports: ['usb'] }],
    });
    const sel = lastCreate!.authenticatorSelection as AnyRecord;
    expect(sel.authenticatorAttachment).toBe('cross-platform');
    expect(sel.residentKey).toBe('required');
    expect(lastCreate!.hints).toEqual(['security-key']);
    const ex = lastCreate!.excludeCredentials as { id: Uint8Array; transports?: string[] }[];
    expect(ex.length).toBe(1);
    expect(Array.from(ex[0].id)).toEqual([1, 2, 3, 4]);
    expect(ex[0].transports).toEqual(['usb']);
    // PRF is still requested at create: same salts as the device passkey.
    expect((lastCreate!.extensions as AnyRecord).prf).toBeDefined();
  });
  test('an authenticator that already holds an excluded credential is reported as such', async () => {
    createImpl = async () => { throw Object.assign(new Error('exists'), { name: 'InvalidStateError' }); };
    await expect(createPasskey({ ...baseCreate, authenticator: 'security-key' })).rejects.toBeInstanceOf(PasskeyAlreadyRegisteredError);
  });
});

describe('getPasskeyPrf', () => {
  test('existing callers: allowCredentials by id only, no hints', async () => {
    await getPasskeyPrf({ rpId: 'privacypools.com', challenge: new Uint8Array(32), credentialId: 'AQIDBA' });
    const allow = lastGet!.allowCredentials as AnyRecord[];
    expect(allow.length).toBe(1);
    expect(allow[0].transports).toBeUndefined();
    expect(lastGet!.hints).toBeUndefined();
  });
  test('discoverable when no credential is named', async () => {
    await getPasskeyPrf({ rpId: 'privacypools.com', challenge: new Uint8Array(32), authenticator: 'security-key' });
    expect(lastGet!.allowCredentials).toBeUndefined();
    expect(lastGet!.hints).toEqual(['security-key']);
  });
  test('a recorded security key is targeted with its transports and returns the userHandle', async () => {
    const res = await getPasskeyPrf({
      rpId: 'privacypools.com',
      challenge: new Uint8Array(32),
      credentialId: 'AQIDBA',
      transports: ['usb', 'nfc'],
      authenticator: 'security-key',
    });
    const allow = lastGet!.allowCredentials as AnyRecord[];
    expect(allow[0].transports).toEqual(['usb', 'nfc']);
    expect(res.userHandle?.length).toBe(32);
    expect(res.prf.first).toBe(`0x${'07'.repeat(32)}`);
  });
  test('a dismissed prompt stays a cancellation', async () => {
    getImpl = async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); };
    await expect(getPasskeyPrf({ rpId: 'privacypools.com', challenge: new Uint8Array(32) })).rejects.toBeInstanceOf(PasskeyCancelledError);
  });
});
