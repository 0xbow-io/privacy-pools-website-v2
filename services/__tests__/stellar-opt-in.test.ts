import { describe, expect, test } from 'bun:test';
import { resolveStellarOptIn, stellarRequestedInUrl, STELLAR_OPT_IN_STORAGE_KEY, type StellarOptInStorage } from '../stellar-opt-in';

function memory(): StellarOptInStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
    removeItem: (k) => { delete data[k]; },
  };
}

describe('resolveStellarOptIn', () => {
  test('off with no param and nothing stored', () => {
    expect(resolveStellarOptIn({ search: '', storage: memory() })).toBe(false);
  });
  test('?stellar=true turns it on and remembers it', () => {
    const s = memory();
    expect(resolveStellarOptIn({ search: '?stellar=true', storage: s })).toBe(true);
    expect(s.data[STELLAR_OPT_IN_STORAGE_KEY]).toBe('1');
    expect(resolveStellarOptIn({ search: '', storage: s })).toBe(true);
  });
  test('?stellar=false forgets it', () => {
    const s = memory();
    resolveStellarOptIn({ search: '?stellar=true', storage: s });
    expect(resolveStellarOptIn({ search: '?stellar=false', storage: s })).toBe(false);
    expect(s.data).toEqual({});
  });
  test('off the web (no search) it is always off', () => {
    const s = memory();
    s.setItem(STELLAR_OPT_IN_STORAGE_KEY, '1');
    expect(resolveStellarOptIn({ search: undefined, storage: s })).toBe(false);
  });
  test('other values do not turn it on', () => {
    expect(resolveStellarOptIn({ search: '?stellar=yes', storage: memory() })).toBe(false);
  });
});

test('?stellar=true stays on when storage throws', () => {
  const throwing = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  expect(resolveStellarOptIn({ search: '?stellar=true', storage: throwing })).toBe(true);
});

// config/chains cannot be imported under bun (react-native), so its gate is
// pinned by source: ?stellar=true only counts where the environment includes
// Stellar (staging), and it never adds the chain by itself.
describe('Stellar opt-in is staging only', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const source = readFileSync(require.resolve('../../config/chains.ts'), 'utf8');

  test('the opt-in is read only when the environment includes Stellar', () => {
    expect(source).toMatch(/export const STELLAR_OPT_IN: boolean = ACTIVE_ENVIRONMENT\.includesStellar && resolveRuntimeStellarOptIn\(\);/);
  });

  test('the supported chain list is not widened by the opt-in', () => {
    expect(source).not.toMatch(/includesStellar \|\| STELLAR_OPT_IN/);
    expect(source).toMatch(/\.\.\.\(ACTIVE_ENVIRONMENT\.includesStellar \? \[STELLAR_TESTNET_ID\] : \[\]\)/);
  });
});

describe('?stellar=true selects Stellar on that load only', () => {
  test('the URL param asks for it, a remembered opt-in does not', () => {
    expect(stellarRequestedInUrl('?stellar=true')).toBe(true);
    expect(stellarRequestedInUrl('?stellar=1&debug=1')).toBe(true);
    expect(stellarRequestedInUrl('')).toBe(false);
    expect(stellarRequestedInUrl('?stellar=false')).toBe(false);
    expect(stellarRequestedInUrl(undefined)).toBe(false);
  });

  test('the selector starts on Stellar only when it is served (source pin)', () => {
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const chains = readFileSync(require.resolve('../../config/chains.ts'), 'utf8');
    const provider = readFileSync(require.resolve('../../components/chain-provider.tsx'), 'utf8');
    expect(chains).toMatch(/export const STELLAR_SELECTED_BY_URL: boolean = STELLAR_OPT_IN && runtimeStellarRequestedInUrl\(\);/);
    expect(provider).toMatch(/STELLAR_SELECTED_BY_URL && supportedChainIds\.includes\(STELLAR_TESTNET_ID\) \? STELLAR_TESTNET_ID : homeChainId/);
  });
});
