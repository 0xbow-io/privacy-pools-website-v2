import { describe, expect, test } from 'bun:test';

import { readAppEnvironment } from '@/config/app-environment';
import { stellarUnlockErrorTitle } from '@/services/stellar/stellar-copy';
import { withStellarLinkParams } from '@/services/stellar/stellar-link';
import { resolveStellarOptIn } from '@/services/stellar-opt-in';

describe('withStellarLinkParams', () => {
  test('a Stellar pay link carries the opt-in and its world', () => {
    const link = withStellarLinkParams('https://v2.privacypools.com/pay/xlm.abc', 'staging');
    const url = new URL(link);
    expect(url.pathname).toBe('/pay/xlm.abc');
    expect(url.searchParams.get('stellar')).toBe('true');
    expect(url.searchParams.get('env')).toBe('staging');
  });

  test('replaces a stale env instead of appending a second one', () => {
    const link = withStellarLinkParams('https://x.test/pay/xlm.a?env=prod&stellar=false', 'staging');
    const url = new URL(link);
    expect(url.searchParams.getAll('env')).toEqual(['staging']);
    expect(url.searchParams.getAll('stellar')).toEqual(['true']);
  });

  test('a fresh browser opening the link lands in that world with Stellar on', () => {
    const search = new URL(withStellarLinkParams('https://x.test/pay/xlm.a', 'staging')).search;
    const storage = new Map<string, string>();
    const store = {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v); },
      removeItem: (k: string) => { storage.delete(k); },
    };
    expect(readAppEnvironment({ search, storage: store, buildDefault: 'prod' })).toBe('staging');
    expect(resolveStellarOptIn({ search, storage: store })).toBe(true);
  });

  test('a relative base is returned unchanged', () => {
    expect(withStellarLinkParams('/pay/xlm.a', 'prod')).toBe('/pay/xlm.a');
  });
});

describe('stellarUnlockErrorTitle', () => {
  test('a declined signature reads as cancelled', () => {
    expect(stellarUnlockErrorTitle(new Error('User declined access'))).toBe('Sign-in cancelled in Freighter.');
  });
  test('anything else goes through the Stellar error copy', () => {
    expect(stellarUnlockErrorTitle(new Error('StellarWalletNetworkMismatch'))).toContain('another network');
  });
});

describe('withStellarLinkParams staging-mainnet', () => {
  test('a link made under ?env=staging-mainnet keeps it', () => {
    const url = new URL(withStellarLinkParams('https://x.test/pay/xlm.a', 'staging', { stagingMainnet: true }));
    expect(url.searchParams.get('env')).toBe('staging-mainnet');
  });
  test('prod never becomes staging-mainnet', () => {
    const url = new URL(withStellarLinkParams('https://x.test/pay/xlm.a', 'prod', { stagingMainnet: true }));
    expect(url.searchParams.get('env')).toBe('prod');
  });
});

describe('stellarUnlockErrorTitle contract errors', () => {
  test('a contract rejection whose log says "rejected" is not a cancel', () => {
    expect(stellarUnlockErrorTitle(new Error('HostError: Error(Contract, #12) ... rejected'))).toContain('error #12');
  });
});
