// Prod vs Staging selection (config/app-environment.ts): the pure resolver
// and the storage-facing reader. The module-level ACTIVE_APP_ENVIRONMENT is
// pinned to staging for the unit suite (tests/bun-test-preload.ts), so the
// default-is-prod rule is asserted through the pure functions here.
import { describe, expect, test } from 'bun:test';
import {
  APP_ENVIRONMENT_STORAGE_KEY,
  DEFAULT_APP_ENVIRONMENT,
  appEnvironmentLabel,
  envScopedStorageKey,
  isStagingOnlyHostname,
  parseAppEnvironment,
  readAppEnvironment,
  resolveAppEnvironment,
  withAppEnvironmentQuery,
} from '@/config/app-environment';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
  };
}

describe('parseAppEnvironment', () => {
  test('accepts the two worlds, case- and whitespace-insensitively', () => {
    expect(parseAppEnvironment('prod')).toBe('prod');
    expect(parseAppEnvironment(' Staging ')).toBe('staging');
  });

  test('rejects anything else', () => {
    expect(parseAppEnvironment('production')).toBeUndefined();
    expect(parseAppEnvironment('dev')).toBeUndefined();
    expect(parseAppEnvironment('')).toBeUndefined();
    expect(parseAppEnvironment(null)).toBeUndefined();
    expect(parseAppEnvironment(undefined)).toBeUndefined();
  });
});

describe('resolveAppEnvironment', () => {
  test('default is prod', () => {
    expect(DEFAULT_APP_ENVIRONMENT).toBe('prod');
    expect(resolveAppEnvironment({})).toBe('prod');
    expect(resolveAppEnvironment({ query: null, stored: null, buildDefault: null })).toBe('prod');
  });

  test('a stored choice beats the build default, a query beats both', () => {
    expect(resolveAppEnvironment({ buildDefault: 'staging' })).toBe('staging');
    expect(resolveAppEnvironment({ stored: 'prod', buildDefault: 'staging' })).toBe('prod');
    expect(resolveAppEnvironment({ query: 'staging', stored: 'prod', buildDefault: 'prod' })).toBe('staging');
  });

  test('garbage at one level falls through to the next', () => {
    expect(resolveAppEnvironment({ query: 'nope', stored: 'staging' })).toBe('staging');
    expect(resolveAppEnvironment({ query: 'nope', stored: 'junk', buildDefault: 'staging' })).toBe('staging');
    expect(resolveAppEnvironment({ query: 'nope', stored: 'junk', buildDefault: 'junk' })).toBe('prod');
  });
});

describe('readAppEnvironment', () => {
  test('no storage and no query resolves to prod', () => {
    expect(readAppEnvironment({ search: '', storage: null })).toBe('prod');
    expect(readAppEnvironment({})).toBe('prod');
  });

  test('a throwing storage is a missing storage, never an import-time crash', () => {
    const storage = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('SecurityError'); },
    };
    expect(readAppEnvironment({ search: '', storage })).toBe('prod');
    expect(readAppEnvironment({ search: '?env=staging', storage })).toBe('staging');
  });

  test('reads the stored choice', () => {
    const storage = memoryStorage({ [APP_ENVIRONMENT_STORAGE_KEY]: 'staging' });
    expect(readAppEnvironment({ search: '', storage })).toBe('staging');
    // Nothing to persist: no query override.
    expect(storage.map.size).toBe(1);
  });

  test('?env= wins and is persisted so the next reload lands in the same world', () => {
    const storage = memoryStorage({ [APP_ENVIRONMENT_STORAGE_KEY]: 'prod' });
    expect(readAppEnvironment({ search: '?debug=1&env=staging', storage })).toBe('staging');
    expect(storage.getItem(APP_ENVIRONMENT_STORAGE_KEY)).toBe('staging');
  });

  test('a ?stellar=true link opens the staging world, where Stellar lives, even over a stored Prod', () => {
    const storage = memoryStorage({ [APP_ENVIRONMENT_STORAGE_KEY]: 'prod' });
    expect(readAppEnvironment({ search: '?stellar=true&action=withdraw', storage })).toBe('staging');
    expect(storage.getItem(APP_ENVIRONMENT_STORAGE_KEY)).toBe('staging');
    expect(readAppEnvironment({ search: '?stellar=1', storage: memoryStorage() })).toBe('staging');
    // An explicit ?env= still wins, and a prod that serves Stellar keeps prod.
    expect(readAppEnvironment({ search: '?stellar=true&env=prod', storage: memoryStorage() })).toBe('prod');
    expect(readAppEnvironment({ search: '?stellar=true', storage: memoryStorage(), prodIncludesStellar: true })).toBe('prod');
    expect(readAppEnvironment({ search: '?stellar=false', storage: memoryStorage() })).toBe('prod');
  });

  test('an invalid ?env= is ignored and not persisted', () => {
    const storage = memoryStorage();
    expect(readAppEnvironment({ search: '?env=devnet', storage })).toBe('prod');
    expect(storage.getItem(APP_ENVIRONMENT_STORAGE_KEY)).toBeNull();
  });
});

describe('staging-only hostnames (the dev-branch test domain)', () => {
  test('recognises the test hosts and nothing else', () => {
    expect(isStagingOnlyHostname('test.privacypools.com')).toBe(true);
    expect(isStagingOnlyHostname('TEST.privacypools.com')).toBe(true);
    expect(isStagingOnlyHostname('testnet.privacypools.com')).toBe(true);
    expect(isStagingOnlyHostname('v2.privacypools.com')).toBe(false);
    expect(isStagingOnlyHostname('privacypools.com')).toBe(false);
    expect(isStagingOnlyHostname('test.privacypools.com.evil.example')).toBe(false);
    expect(isStagingOnlyHostname('')).toBe(false);
    expect(isStagingOnlyHostname(null)).toBe(false);
  });

  test('always staging: ?env=prod, a stored prod choice and a prod build default are ignored', () => {
    const hostname = 'test.privacypools.com';
    const storage = memoryStorage({ [APP_ENVIRONMENT_STORAGE_KEY]: 'prod' });
    expect(readAppEnvironment({ hostname, search: '?env=prod', storage, buildDefault: 'prod' })).toBe('staging');
    expect(readAppEnvironment({ hostname, search: '', storage: null })).toBe('staging');
  });

  test('nothing is written to storage on a staging-only host', () => {
    const storage = memoryStorage({ [APP_ENVIRONMENT_STORAGE_KEY]: 'prod' });
    readAppEnvironment({ hostname: 'test.privacypools.com', search: '?env=staging', storage });
    expect(storage.map.get(APP_ENVIRONMENT_STORAGE_KEY)).toBe('prod');
  });

  test('other hosts keep the normal precedence', () => {
    expect(readAppEnvironment({ hostname: 'v2.privacypools.com', search: '?env=staging', storage: null })).toBe('staging');
    expect(readAppEnvironment({ hostname: 'v2.privacypools.com', search: '', storage: null })).toBe('prod');
  });
});

describe('labels and storage scoping', () => {
  test('labels are the two words the menu shows', () => {
    expect(appEnvironmentLabel('prod')).toBe('Prod');
    expect(appEnvironmentLabel('staging')).toBe('Staging');
  });

  test('staging keeps the bare key, prod gets a suffix that SecureStore accepts', () => {
    expect(envScopedStorageKey('ppv2_sent_transfers_v1', 'staging')).toBe('ppv2_sent_transfers_v1');
    const prodKey = envScopedStorageKey('ppv2_sent_transfers_v1', 'prod');
    expect(prodKey).toBe('ppv2_sent_transfers_v1_prod');
    // expo-secure-store rejects anything outside [A-Za-z0-9._-].
    expect(prodKey).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  test('the two worlds never share a scoped key', () => {
    expect(envScopedStorageKey('k', 'prod')).not.toBe(envScopedStorageKey('k', 'staging'));
  });
});

describe('withAppEnvironmentQuery (the reload target of the menu switch)', () => {
  test('sets ?env= and replaces a stale value, keeping the rest of the URL', () => {
    expect(withAppEnvironmentQuery('https://app.test/pools?debug=1', 'staging'))
      .toBe('https://app.test/pools?debug=1&env=staging');
    expect(withAppEnvironmentQuery('https://app.test/?env=staging&debug=1', 'prod'))
      .toBe('https://app.test/?env=prod&debug=1');
  });

  test('the query then outranks a stored choice on the next load, even if storage refused the write', () => {
    const href = withAppEnvironmentQuery('https://app.test/', 'staging');
    const search = new URL(href).search;
    const throwing = { getItem: () => { throw new Error('nope'); }, setItem: () => { throw new Error('nope'); } };
    expect(readAppEnvironment({ search, storage: throwing })).toBe('staging');
    expect(readAppEnvironment({ search, storage: memoryStorage({ [APP_ENVIRONMENT_STORAGE_KEY]: 'prod' }) })).toBe('staging');
  });

  test('an unparseable href is returned as is', () => {
    expect(withAppEnvironmentQuery('not a url', 'prod')).toBe('not a url');
  });
});
