import { describe, expect, test } from 'bun:test';
import {
  classifyUserHandle,
  decodeMarkerMeta,
  encodeMarkerMeta,
  mayChoosePasskeyUnlock,
  securityKeyLookupOutcome,
  sanitizeTransports,
  securityKeyOwnerTag,
  securityKeyUserId,
  securityKeyUserName,
  userHandleMatchesOwner,
} from '@/services/passkey-choice';

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const RP = 'privacypools.com';
const base = { signerRefused: false, hasRecordedPasskey: false, isSmartWallet: false };

describe('mayChoosePasskeyUnlock', () => {
  test('an ordinary wallet gets neither: it keeps the wallet signature', () => {
    expect(mayChoosePasskeyUnlock({ ...base, kind: 'security-key' })).toBe(false);
    expect(mayChoosePasskeyUnlock({ ...base, kind: 'platform' })).toBe(false);
  });
  test('the security key has exactly the passkey gate, case by case', () => {
    const cases = [
      { ...base, isSmartWallet: true },
      { ...base, signerRefused: true },
      { ...base, hasRecordedPasskey: true },
      base,
    ];
    for (const c of cases) {
      expect(mayChoosePasskeyUnlock({ ...c, kind: 'security-key' })).toBe(mayChoosePasskeyUnlock({ ...c, kind: 'platform' }));
    }
  });
  test('smart wallets, refused signers and recorded credentials are offered both', () => {
    expect(mayChoosePasskeyUnlock({ ...base, isSmartWallet: true, kind: 'security-key' })).toBe(true);
    expect(mayChoosePasskeyUnlock({ ...base, signerRefused: true, kind: 'security-key' })).toBe(true);
    expect(mayChoosePasskeyUnlock({ ...base, hasRecordedPasskey: true, kind: 'platform' })).toBe(true);
  });
});

describe('security-key user handle', () => {
  test('the owner tag is stable per (owner, RP ID) and case-insensitive', () => {
    expect(securityKeyOwnerTag(OWNER, RP)).toEqual(securityKeyOwnerTag(OWNER.toUpperCase().replace('0X', '0x'), RP.toUpperCase()));
    expect(securityKeyOwnerTag(OWNER, RP)).not.toEqual(securityKeyOwnerTag(OTHER, RP));
    expect(securityKeyOwnerTag(OWNER, RP)).not.toEqual(securityKeyOwnerTag(OWNER, 'localhost'));
    expect(securityKeyOwnerTag(OWNER, RP).length).toBe(16);
  });
  test('user.id = owner tag + random half, so a second setup never overwrites the first credential', () => {
    const a = securityKeyUserId(OWNER, RP, new Uint8Array(16).fill(1));
    const b = securityKeyUserId(OWNER, RP, new Uint8Array(16).fill(2));
    expect(a.length).toBe(32);
    expect(a.slice(0, 16)).toEqual(b.slice(0, 16));
    expect(a).not.toEqual(b);
    expect(() => securityKeyUserId(OWNER, RP, new Uint8Array(8))).toThrow();
  });
  test('an assertion is attributed to its owner, another owner, or nobody', () => {
    const handle = securityKeyUserId(OWNER, RP, crypto.getRandomValues(new Uint8Array(16)));
    expect(userHandleMatchesOwner(handle, OWNER, RP)).toBe(true);
    expect(classifyUserHandle(handle, OWNER, RP)).toBe('owner');
    expect(classifyUserHandle(handle, OTHER, RP)).toBe('other-owner');
    // A legacy credential (16 random bytes, made before owner tags) is never used blindly.
    expect(classifyUserHandle(crypto.getRandomValues(new Uint8Array(16)), OWNER, RP)).toBe('untagged');
    expect(classifyUserHandle(undefined, OWNER, RP)).toBe('untagged');
  });
  test('the name says which wallet the key is for, without the full address', () => {
    expect(securityKeyUserName(OWNER)).toBe('Privacy Pools 0x1111...1111');
    expect(securityKeyUserName('nonsense')).toBe('Privacy Pools wallet');
  });
});

describe('marker metadata', () => {
  test('round-trips kind and transports', () => {
    expect(decodeMarkerMeta(encodeMarkerMeta({ kind: 'security-key', transports: ['usb', 'nfc'] }))).toEqual({
      kind: 'security-key',
      transports: ['usb', 'nfc'],
    });
  });
  test('missing or malformed metadata reads as a device passkey, like every marker before it', () => {
    expect(decodeMarkerMeta(null)).toEqual({ kind: 'platform', transports: [] });
    expect(decodeMarkerMeta('{oops')).toEqual({ kind: 'platform', transports: [] });
    expect(decodeMarkerMeta('{"kind":"weird"}')).toEqual({ kind: 'platform', transports: [] });
  });
  test('transports are limited to the ones WebAuthn defines', () => {
    expect(sanitizeTransports(['usb', 'usb', 'x', 3, 'nfc', 'hybrid'])).toEqual(['usb', 'nfc', 'hybrid']);
    expect(sanitizeTransports('usb')).toEqual([]);
  });
});

describe('securityKeyLookupOutcome: a closed prompt never means "empty key"', () => {
  const T = 120_000;
  test('Sign in: a cancelled prompt is just closed, never a reason to create', () => {
    expect(securityKeyLookupOutcome({ stage: 'find', elapsedMs: 800, timeoutMs: T })).toBe('closed');
  });
  test('Sign in: a timed-out prompt is just closed', () => {
    expect(securityKeyLookupOutcome({ stage: 'find', elapsedMs: T, timeoutMs: T })).toBe('closed');
  });
  test('Set up a new key: a timeout (nobody touched the key) stops, nothing is created', () => {
    expect(securityKeyLookupOutcome({ stage: 'check', elapsedMs: T, timeoutMs: T })).toBe('closed');
    expect(securityKeyLookupOutcome({ stage: 'check', elapsedMs: T - 1_000, timeoutMs: T })).toBe('closed');
  });
  test('Set up a new key: a closed look-up only asks for an explicit second tap', () => {
    expect(securityKeyLookupOutcome({ stage: 'check', elapsedMs: 3_000, timeoutMs: T })).toBe('confirm-create');
  });
});
