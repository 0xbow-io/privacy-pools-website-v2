import { describe, expect, test } from 'bun:test';

import {
  classifyVaultBytecode,
  probeYieldVault,
  recordYieldVaultProbe,
  resetYieldVaultProbesForTests,
  subscribeYieldVaultProbe,
  yieldVaultProbeState,
  yieldVaultProbeVersion,
  yieldVaultUsable,
} from '@/services/yield-vault-probe';
import { resolveVerifiedYieldDeployment, resolveYieldDeployment, resolveYieldDepositDeploymentForUnderlying } from '../../config/yield';

// Pat's exact case, 2026-09-02: the Sepolia preview's env named this vault and
// every USDC deposit died in previewDeposit because nothing is deployed there.
const PLACEHOLDER = '0x2222222222222222222222222222222222222222';
const REAL_CODE = '0x6080604052348015600f57600080fd5b50';
const SEPOLIA = 11155111;
const DEPLOYMENT = {
  ppRouter: '0x08e984a00E5575b366310f3dE7f53135e139F1b1' as `0x${string}`,
  ppUSDC: PLACEHOLDER as `0x${string}`,
  ppUSDCDecimals: 18,
  underlying: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as `0x${string}`,
  underlyingDecimals: 6,
  underlyingSymbol: 'USDC',
  apyLabel: 'Aave v3',
};
const FLAGS_ON = { enabled: true, withdrawReady: true };

describe('classifyVaultBytecode', () => {
  test('a placeholder address with no code is missing, however the RPC spells "nothing"', () => {
    expect(classifyVaultBytecode(['0x', REAL_CODE])).toBe('missing');
    expect(classifyVaultBytecode([undefined, REAL_CODE])).toBe('missing');
    expect(classifyVaultBytecode([null, REAL_CODE])).toBe('missing');
    expect(classifyVaultBytecode(['', REAL_CODE])).toBe('missing');
    expect(classifyVaultBytecode(['  0X  ', REAL_CODE])).toBe('missing');
  });

  test('BOTH contracts must have code; one real one is not enough', () => {
    expect(classifyVaultBytecode([REAL_CODE, '0x'])).toBe('missing');
    expect(classifyVaultBytecode([REAL_CODE, REAL_CODE])).toBe('ok');
  });

  test('nothing verified is not the same as everything verified', () => {
    expect(classifyVaultBytecode([])).toBe('missing');
  });
});

describe('probe state', () => {
  test('a chain is unusable until a probe has positively verified it', () => {
    resetYieldVaultProbesForTests();
    expect(yieldVaultProbeState(SEPOLIA)).toBe('unverified');
    // The property the whole guard rests on: an env var alone opens nothing.
    expect(yieldVaultUsable(SEPOLIA)).toBe(false);
  });

  test('the Sepolia placeholder vault is probed as missing and stays unusable', async () => {
    resetYieldVaultProbesForTests();
    const getCode = async (addr: string) => (addr === PLACEHOLDER ? '0x' : REAL_CODE);
    expect(await probeYieldVault(SEPOLIA, DEPLOYMENT, getCode)).toBe('missing');
    expect(yieldVaultProbeState(SEPOLIA)).toBe('missing');
    expect(yieldVaultUsable(SEPOLIA)).toBe(false);
  });

  test('a real deployment is probed as ok and becomes usable', async () => {
    resetYieldVaultProbesForTests();
    expect(await probeYieldVault(SEPOLIA, DEPLOYMENT, async () => REAL_CODE)).toBe('ok');
    expect(yieldVaultUsable(SEPOLIA)).toBe(true);
  });

  test('an RPC that will not answer fails CLOSED and does not throw', async () => {
    resetYieldVaultProbesForTests();
    const verdict = await probeYieldVault(SEPOLIA, DEPLOYMENT, async () => { throw new Error('rpc down'); });
    expect(verdict).toBe('unreachable');
    // Kept distinct from 'missing' so a log line can say which, but equally unusable.
    expect(yieldVaultUsable(SEPOLIA)).toBe(false);
  });

  test('verdicts are per chain', async () => {
    resetYieldVaultProbesForTests();
    await probeYieldVault(SEPOLIA, DEPLOYMENT, async () => '0x');
    await probeYieldVault(1, DEPLOYMENT, async () => REAL_CODE);
    expect(yieldVaultUsable(SEPOLIA)).toBe(false);
    expect(yieldVaultUsable(1)).toBe(true);
  });

  test('recording a verdict wakes subscribers and bumps the version, once per change', () => {
    resetYieldVaultProbesForTests();
    let wakes = 0;
    const unsubscribe = subscribeYieldVaultProbe(() => { wakes += 1; });
    const v0 = yieldVaultProbeVersion();
    recordYieldVaultProbe(SEPOLIA, 'missing');
    recordYieldVaultProbe(SEPOLIA, 'missing'); // same value: no churn
    expect(wakes).toBe(1);
    expect(yieldVaultProbeVersion()).toBe(v0 + 1);
    recordYieldVaultProbe(SEPOLIA, 'ok');
    expect(wakes).toBe(2);
    unsubscribe();
    recordYieldVaultProbe(SEPOLIA, 'missing');
    expect(wakes).toBe(2);
  });

  test('a deposit route closes again when its probe flips unverified to ok to unreachable', () => {
    resetYieldVaultProbesForTests();
    const map = { [SEPOLIA]: [DEPLOYMENT] };
    const resolve = () => resolveYieldDepositDeploymentForUnderlying(
      SEPOLIA,
      DEPLOYMENT.underlying,
      FLAGS_ON,
      map,
      yieldVaultUsable,
    );
    expect(resolve()).toBeUndefined();
    recordYieldVaultProbe(SEPOLIA, 'ok', DEPLOYMENT.ppUSDC);
    expect(resolve()?.ppRouter).toBe(DEPLOYMENT.ppRouter);
    recordYieldVaultProbe(SEPOLIA, 'unreachable', DEPLOYMENT.ppUSDC);
    expect(resolve()).toBeUndefined();
  });

  test('a throwing subscriber does not stop the others being notified', () => {
    resetYieldVaultProbesForTests();
    let reached = false;
    subscribeYieldVaultProbe(() => { throw new Error('bad listener'); });
    subscribeYieldVaultProbe(() => { reached = true; });
    recordYieldVaultProbe(SEPOLIA, 'ok');
    expect(reached).toBe(true);
  });
});

describe('the verified gate in config/yield', () => {
  const map = { [SEPOLIA]: DEPLOYMENT };

  test('flags on + deployment present is NOT enough: the vault must be verified', () => {
    // This is the bug. Before 2026-09-02 the flags alone opened the gate.
    expect(resolveYieldDeployment(SEPOLIA, FLAGS_ON, map)).toBeDefined();
    expect(resolveVerifiedYieldDeployment(SEPOLIA, { ...FLAGS_ON, vaultVerified: false }, map)).toBeUndefined();
  });

  test('a verified vault passes through unchanged', () => {
    expect(resolveVerifiedYieldDeployment(SEPOLIA, { ...FLAGS_ON, vaultVerified: true }, map)?.ppUSDC).toBe(DEPLOYMENT.ppUSDC);
  });

  test('verification never overrides the flags: it can only close the gate, not open it', () => {
    expect(resolveVerifiedYieldDeployment(SEPOLIA, { enabled: false, withdrawReady: true, vaultVerified: true }, map)).toBeUndefined();
    expect(resolveVerifiedYieldDeployment(SEPOLIA, { enabled: true, withdrawReady: false, vaultVerified: true }, map)).toBeUndefined();
    expect(resolveVerifiedYieldDeployment(1, { ...FLAGS_ON, vaultVerified: true }, map)).toBeUndefined();
  });
});

describe('per-share probe records (2026-09-04)', () => {
  const A = '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6';
  const B = '0xA4cF419558Ef36CC6FfB666195684dC963910426';
  test('each share carries its own verdict; the chain is usable when any share is', () => {
    const { recordYieldVaultProbe, resetYieldVaultProbesForTests, yieldVaultUsable, yieldVaultProbeState } = require('../yield-vault-probe') as typeof import('../yield-vault-probe');
    resetYieldVaultProbesForTests();
    recordYieldVaultProbe(1, 'ok', A);
    recordYieldVaultProbe(1, 'missing', B);
    expect(yieldVaultUsable(1, A)).toBe(true);
    expect(yieldVaultUsable(1, B.toLowerCase())).toBe(false);
    expect(yieldVaultUsable(1)).toBe(true);
    expect(yieldVaultProbeState(1, '0x0000000000000000000000000000000000000009')).toBe('unverified');
    // A chain-wide record (legacy, no share) is inherited by every share without its own.
    recordYieldVaultProbe(56, 'ok');
    expect(yieldVaultUsable(56, B)).toBe(true);
    expect(yieldVaultUsable(56)).toBe(true);
    resetYieldVaultProbesForTests();
  });
});

describe('structural router verification (codex, 2026-09-04)', () => {
  const { probeYieldVault, resetYieldVaultProbesForTests, routerMatches, yieldVaultUsable } = require('../yield-vault-probe') as typeof import('../yield-vault-probe');
  const dep = { ppUSDC: '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6', ppRouter: '0xe76E793d776c1e207aD7a7fa7C57d27420d85110' };
  const expected = { entrypoint: '0xca1e072236D231130059eeA6Bfceb7F4e9a1F0C3', poolVault: '0x0Eb42804BF897662aF851370eaeAdcDBEC1b97ed' };
  const good = { vault: dep.ppUSDC.toLowerCase(), entrypoint: expected.entrypoint.toUpperCase().replace('0X', '0x'), poolVault: expected.poolVault };
  test('routerMatches compares share, Entrypoint and PoolVault case-insensitively', () => {
    expect(routerMatches(good, dep, expected)).toBe(true);
    expect(routerMatches({ ...good, vault: '0xA4cF419558Ef36CC6FfB666195684dC963910426' }, dep, expected)).toBe(false);
    expect(routerMatches({ ...good, entrypoint: '0x0000000000000000000000000000000000000001' }, dep, expected)).toBe(false);
    expect(routerMatches({ ...good, poolVault: '0x0000000000000000000000000000000000000001' }, dep, expected)).toBe(false);
  });
  test('bytecode alone is not enough: a router wrapping another share is recorded missing; a matching one ok; a failing read unreachable', async () => {
    resetYieldVaultProbesForTests();
    const code = async () => '0x6080';
    expect(await probeYieldVault(1, dep, code, { expected, readRouter: async () => ({ ...good, vault: '0xA4cF419558Ef36CC6FfB666195684dC963910426' }) })).toBe('missing');
    expect(yieldVaultUsable(1, dep.ppUSDC)).toBe(false);
    expect(await probeYieldVault(1, dep, code, { expected, readRouter: async () => good })).toBe('ok');
    expect(yieldVaultUsable(1, dep.ppUSDC)).toBe(true);
    expect(await probeYieldVault(56, dep, code, { expected, readRouter: async () => { throw new Error('rpc'); } })).toBe('unreachable');
    resetYieldVaultProbesForTests();
  });
});
