import { describe, expect, test } from 'bun:test';
import {
  classifyUserHandle,
  decodeMarkerMeta,
  encodeMarkerMeta,
  mayChoosePasskeyUnlock,
  sanitizeTransports,
  securityKeyOwnerTag,
  securityKeyUserId,
  securityKeyUserName,
  userHandleMatchesOwner,
} from '@/services/passkey-choice';

const OWNER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const RP = 'privacypools.com';
const base = { signerRefused: false, hasRecordedPasskey: false, isSmartWallet: false, securityKeyFlag: false };

describe('mayChoosePasskeyUnlock', () => {
  test('an ordinary wallet gets nothing without the flag', () => {
    expect(mayChoosePasskeyUnlock({ ...base, kind: 'security-key' })).toBe(false);
    expect(mayChoosePasskeyUnlock({ ...base, kind: 'platform' })).toBe(false);
  });
  test('the flag allows a security key up front, never a device passkey', () => {
    expect(mayChoosePasskeyUnlock({ ...base, securityKeyFlag: true, kind: 'security-key' })).toBe(true);
    expect(mayChoosePasskeyUnlock({ ...base, securityKeyFlag: true, kind: 'platform' })).toBe(false);
  });
  test('a refused signer may pick either kind', () => {
    expect(mayChoosePasskeyUnlock({ ...base, signerRefused: true, kind: 'security-key' })).toBe(true);
    expect(mayChoosePasskeyUnlock({ ...base, signerRefused: true, kind: 'platform' })).toBe(true);
  });
  test('a wallet this browser already unlocked with a passkey gets it back without failing first', () => {
    expect(mayChoosePasskeyUnlock({ ...base, hasRecordedPasskey: true, kind: 'platform' })).toBe(true);
  });
  test('a smart wallet may switch to a security key without the flag', () => {
    expect(mayChoosePasskeyUnlock({ ...base, isSmartWallet: true, kind: 'security-key' })).toBe(true);
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
