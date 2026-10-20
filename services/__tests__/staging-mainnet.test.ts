// ?env=staging-mainnet (config/staging-mainnet.ts): the staging world with its
// Ethereum, OP and Base pools. Plain staging never shows them, and no menu
// offers the value. The unit suite runs as staging-mainnet
// (tests/bun-test-preload.ts), so plain staging is checked in a child process.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { APP_ENVIRONMENTS, parseAppEnvironment, resolveAppEnvironment } from '@/config/app-environment';
import { resolveStagingMainnet, resolveStagingMainnetSource, STAGING_MAINNET_STORAGE_KEY } from '@/config/staging-mainnet';
import { STAGING_MAINNET_ONLY_CHAIN_IDS } from '@/config/staging-deployments';
import { ENVIRONMENTS } from '@/config/environments';

function memory(init: Record<string, string> = {}) {
  const data: Record<string, string> = { ...init };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
    removeItem: (k: string) => { delete data[k]; },
  };
}

describe('resolveStagingMainnet', () => {
  test('?env=staging-mainnet turns it on and remembers it', () => {
    const storage = memory();
    expect(resolveStagingMainnet({ search: '?env=staging-mainnet', storage })).toBe(true);
    expect(storage.data[STAGING_MAINNET_STORAGE_KEY]).toBe('1');
    expect(resolveStagingMainnet({ search: '', storage })).toBe(true);
  });

  test('any other ?env= forgets it, even over a build default', () => {
    const storage = memory({ [STAGING_MAINNET_STORAGE_KEY]: '1' });
    expect(resolveStagingMainnet({ search: '?env=staging', storage, buildDefault: 'true' })).toBe(false);
    expect(storage.data[STAGING_MAINNET_STORAGE_KEY]).toBeUndefined();
    expect(resolveStagingMainnet({ search: '?env=prod', storage: memory({ [STAGING_MAINNET_STORAGE_KEY]: '1' }) })).toBe(false);
  });

  test('off by default; the build default only applies with no query and nothing stored', () => {
    expect(resolveStagingMainnet({})).toBe(false);
    expect(resolveStagingMainnet({ buildDefault: 'true' })).toBe(true);
    expect(resolveStagingMainnet({ buildDefault: 'false' })).toBe(false);
  });

  test('an empty ?env= also forgets it', () => {
    const storage = memory({ [STAGING_MAINNET_STORAGE_KEY]: '1' });
    expect(resolveStagingMainnet({ search: '?env=', storage })).toBe(false);
    expect(storage.data[STAGING_MAINNET_STORAGE_KEY]).toBeUndefined();
  });

  test('only a tester opt-in is explicit; the build default never lifts the production-host backstop', () => {
    expect(resolveStagingMainnetSource({ buildDefault: 'true' })).toEqual({ on: true, explicit: false });
    expect(resolveStagingMainnetSource({ search: '?env=staging-mainnet', storage: memory() })).toEqual({ on: true, explicit: true });
    expect(resolveStagingMainnetSource({ storage: memory({ [STAGING_MAINNET_STORAGE_KEY]: '1' }) })).toEqual({ on: true, explicit: true });
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const src = readFileSync(require.resolve('../../config/staging-deployments.ts'), 'utf8');
    expect(src).toMatch(/\(!onPublicProductionHost \|\| STAGING_MAINNET_EXPLICIT\)/);
    expect(src).not.toMatch(/onPublicProductionHost \|\| STAGING_MAINNET_OPT_IN/);
  });

  test('a throwing storage does not take it down', () => {
    const storage = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    expect(resolveStagingMainnet({ search: '?env=staging-mainnet', storage })).toBe(true);
    expect(resolveStagingMainnet({ storage })).toBe(false);
  });
});

describe('the app environment', () => {
  test('staging-mainnet is the staging world', () => {
    expect(parseAppEnvironment('staging-mainnet')).toBe('staging');
    expect(resolveAppEnvironment({ query: 'staging-mainnet', stored: 'prod' })).toBe('staging');
  });

  test('no menu offers it: the switcher lists prod and staging only', () => {
    expect([...APP_ENVIRONMENTS]).toEqual(['prod', 'staging']);
  });
});

const PLAIN = process.env.EXPO_PUBLIC_STAGING_MAINNET === 'false';
// Plain conditionals rather than describe.if (the app's bun:test typings do not model it).
const noop = (_name: string, _fn: () => void) => {};
const describePlain = PLAIN ? describe : noop;
const describeMainnet = PLAIN ? noop : describe;

describePlain('plain staging (child process, EXPO_PUBLIC_STAGING_MAINNET=false)', () => {
  test('Ethereum, OP and Base pools are not served', () => {
    const ids = ENVIRONMENTS.staging.deployments.map((d) => d.chainId);
    for (const id of STAGING_MAINNET_ONLY_CHAIN_IDS) expect(ids).not.toContain(id);
    for (const id of STAGING_MAINNET_ONLY_CHAIN_IDS) expect(ENVIRONMENTS.staging.deploymentsByChain[id]).toBeUndefined();
  });

  test('it boots on Sepolia', () => {
    expect(ENVIRONMENTS.staging.defaultChainId).toBe(11155111);
  });

  test('the hidden set is exactly Ethereum, OP and Base', () => {
    expect([...STAGING_MAINNET_ONLY_CHAIN_IDS].sort((a, b) => a - b)).toEqual([1, 10, 8453]);
  });
});

describeMainnet('staging-mainnet (this process)', () => {
  test('serves the Ethereum, OP and Base pools and boots on Ethereum', () => {
    const ids = ENVIRONMENTS.staging.deployments.map((d) => d.chainId);
    for (const id of STAGING_MAINNET_ONLY_CHAIN_IDS) expect(ids).toContain(id);
    expect(ENVIRONMENTS.staging.defaultChainId).toBeUndefined();
    expect(ids[0]).toBe(1);
  });

  test('plain staging, run in a child with the build default off', () => {
    const run = spawnSync(process.execPath, ['test', 'services/__tests__/staging-mainnet.test.ts'], {
      cwd: join(new URL('.', import.meta.url).pathname, '..', '..'),
      encoding: 'utf8',
      env: { ...process.env, EXPO_PUBLIC_APP_ENV: 'staging', EXPO_PUBLIC_STAGING_MAINNET: 'false' },
    });
    const out = `${run.stdout}\n${run.stderr}`;
    if (run.status !== 0) console.error(out);
    expect(run.status).toBe(0);
    // Summary counts, the repo's child-run pattern. The plain branch has three
    // tests and this one two, so a child that took the wrong branch reports 10.
    expect(out).toMatch(/ 11 pass/);
    expect(out).toMatch(/ 0 fail/);
  }, 60_000);
});
