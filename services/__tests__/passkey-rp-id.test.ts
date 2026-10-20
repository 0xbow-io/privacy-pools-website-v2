import { describe, expect, test } from 'bun:test';
import { PASSKEY_APEX_DOMAIN, passkeyRpIdFor } from '@/services/passkey-rp-id';

describe('passkeyRpIdFor', () => {
  test('every privacypools.com page shares the apex RP ID', () => {
    expect(passkeyRpIdFor('v2.privacypools.com')).toBe(PASSKEY_APEX_DOMAIN);
    expect(passkeyRpIdFor('v3.privacypools.com')).toBe(PASSKEY_APEX_DOMAIN);
    expect(passkeyRpIdFor('privacypools.com')).toBe(PASSKEY_APEX_DOMAIN);
    expect(passkeyRpIdFor('V2.PrivacyPools.com')).toBe(PASSKEY_APEX_DOMAIN);
  });
  test('other hosts keep their own hostname', () => {
    expect(passkeyRpIdFor('localhost')).toBe('localhost');
    expect(passkeyRpIdFor('some-other-branch-0xbow.vercel.app')).toBe('some-other-branch-0xbow.vercel.app');
    // A look-alike domain is not ours.
    expect(passkeyRpIdFor('evilprivacypools.com')).toBe('evilprivacypools.com');
    expect(passkeyRpIdFor('privacypools.com.evil.io')).toBe('privacypools.com.evil.io');
  });
  test('no hostname falls back to localhost', () => {
    expect(passkeyRpIdFor(undefined)).toBe('localhost');
    expect(passkeyRpIdFor('')).toBe('localhost');
  });
});

describe('related origins', () => {
  test('hosts listed in privacypools.com/.well-known/webauthn get the apex RP ID', () => {
    expect(passkeyRpIdFor('privacy-pools-website-v2.vercel.app')).toBe(PASSKEY_APEX_DOMAIN);
    expect(passkeyRpIdFor('privacy-pools-website-v2-git-feat-passkey-smart-wallets-0xbow.vercel.app')).toBe(PASSKEY_APEX_DOMAIN);
    expect(passkeyRpIdFor('PRIVACY-POOLS-WEBSITE-V2.vercel.app')).toBe(PASSKEY_APEX_DOMAIN);
  });
});
