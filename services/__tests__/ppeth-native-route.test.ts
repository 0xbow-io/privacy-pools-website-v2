// The ppETH launch switch, end to end through the pure layers.
//
// What "one flip" means here: adding a nativeMode entry for chain 1 to the
// environment's yield table (config/prod-deployments.ts on prod, where the
// chain-1 routers are a fixed allowlist) has to be the ONLY thing anyone does.
// These tests pin the three places that decision travels through — the config
// parser, the deposit resolver and the mainnet ETH row — plus the probe check
// that stops the flip from opening a route over the wrong kind of router.

import { describe, expect, test } from 'bun:test';

import { mainnetEth, nativeYieldRouteInTable } from '@/config/environments';
import { parseYieldDeploymentsMap, resolveNativeYieldDepositDeployment } from '@/config/yield';
import { routerMatches } from '@/services/yield-vault-probe';
import type { YieldDeployment } from '@/services/sdk-types';

const ROUTER = '0x1111111111111111111111111111111111111111';
const PP_ETH = '0x2222222222222222222222222222222222222222';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const PP_USDC = '0x3333333333333333333333333333333333333333';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

const ppEthEntry = (overrides: Record<string, unknown> = {}) => ({
  ppRouter: ROUTER,
  ppUSDC: PP_ETH,
  ppUSDCDecimals: 18,
  underlying: WETH,
  underlyingDecimals: 18,
  underlyingSymbol: 'WETH',
  nativeMode: true,
  ...overrides,
});

const ppUsdcEntry = {
  ppRouter: '0x4444444444444444444444444444444444444444',
  ppUSDC: PP_USDC,
  ppUSDCDecimals: 18,
  underlying: USDC,
  underlyingDecimals: 6,
  underlyingSymbol: 'USDC',
};

const ALL_FLAGS_ON = { enabled: true, withdrawReady: true };
const everythingUsable = () => true;

describe('nativeMode survives the config parser', () => {
  test('a ppETH entry parses and keeps its flag', () => {
    const parsed = parseYieldDeploymentsMap(JSON.stringify({ 1: [ppUsdcEntry, ppEthEntry()] }));
    expect(parsed[1]).toHaveLength(2);
    expect(parsed[1]![0]!.nativeMode).toBeUndefined();
    expect(parsed[1]![1]!.nativeMode).toBe(true);
  });

  test('nativeMode: false is dropped rather than carried as a falsy flag', () => {
    const parsed = parseYieldDeploymentsMap(JSON.stringify({ 1: [ppEthEntry({ nativeMode: false })] }));
    expect(parsed[1]![0]!.nativeMode).toBeUndefined();
  });

  // A native router wraps the chain's native coin, which is 18 decimals
  // everywhere we serve, and the production ppETH wrapper is 18-dp shares over
  // an 18-dp underlying (decimals offset 0). Anything else claiming nativeMode
  // is a mis-copied ppUSDC row, and msg.value at that router funds nothing.
  test('a nativeMode entry over a 6-decimal underlying is rejected outright', () => {
    const parsed = parseYieldDeploymentsMap(JSON.stringify({
      1: [ppEthEntry({ underlying: USDC, underlyingDecimals: 6, underlyingSymbol: 'USDC' })],
    }));
    expect(parsed[1]).toBeUndefined();
  });

  test('a nativeMode entry with non-18-decimal shares is rejected outright', () => {
    const parsed = parseYieldDeploymentsMap(JSON.stringify({ 1: [ppEthEntry({ ppUSDCDecimals: 6 })] }));
    expect(parsed[1]).toBeUndefined();
  });

  test('a non-boolean nativeMode is rejected rather than coerced', () => {
    const parsed = parseYieldDeploymentsMap(JSON.stringify({ 1: [ppEthEntry({ nativeMode: 'true' })] }));
    expect(parsed[1]).toBeUndefined();
  });
});

describe('resolveNativeYieldDepositDeployment', () => {
  const table = { 1: parseYieldDeploymentsMap(JSON.stringify({ 1: [ppUsdcEntry, ppEthEntry()] }))[1]! };

  test('picks the native route out of a chain that also runs ERC-20 ones', () => {
    const found = resolveNativeYieldDepositDeployment(1, ALL_FLAGS_ON, table, everythingUsable);
    expect(found?.ppUSDC).toBe(PP_ETH);
  });

  test('is undefined when the chain has no native route', () => {
    const erc20Only = { 1: parseYieldDeploymentsMap(JSON.stringify({ 1: [ppUsdcEntry] }))[1]! };
    expect(resolveNativeYieldDepositDeployment(1, ALL_FLAGS_ON, erc20Only, everythingUsable)).toBeUndefined();
  });

  test('is undefined while the master flags are off, like every other yield route', () => {
    expect(resolveNativeYieldDepositDeployment(1, { enabled: false, withdrawReady: true }, table, everythingUsable))
      .toBeUndefined();
    expect(resolveNativeYieldDepositDeployment(1, { enabled: true, withdrawReady: false }, table, everythingUsable))
      .toBeUndefined();
  });

  test('is undefined until the vault probe says the share is usable', () => {
    expect(resolveNativeYieldDepositDeployment(1, ALL_FLAGS_ON, table, () => false)).toBeUndefined();
  });
});

describe('the mainnet ETH row', () => {
  const withNative: Record<number, YieldDeployment[]> = {
    1: parseYieldDeploymentsMap(JSON.stringify({ 1: [ppEthEntry()] }))[1]!,
  };
  const withoutNative: Record<number, YieldDeployment[]> = {
    1: parseYieldDeploymentsMap(JSON.stringify({ 1: [ppUsdcEntry] }))[1]!,
  };

  test('stays "Available soon" with no ppETH route configured', () => {
    expect(mainnetEth(withoutNative).depositComingSoon).toBe(true);
    expect(mainnetEth(undefined).depositComingSoon).toBe(true);
  });

  test('opens the moment a ppETH route is in the table — the flip', () => {
    expect(mainnetEth(withNative).depositComingSoon).toBeUndefined();
    expect(mainnetEth(withNative)).toMatchObject({ symbol: 'ETH', decimals: 18, isNative: true });
  });

  test('a native route on another chain does not open mainnet', () => {
    const elsewhere = { 10: parseYieldDeploymentsMap(JSON.stringify({ 10: [ppEthEntry()] }))[10]! };
    expect(nativeYieldRouteInTable(elsewhere, 1)).toBe(false);
    expect(mainnetEth(elsewhere).depositComingSoon).toBe(true);
  });
});

describe('the probe refuses a mode mismatch', () => {
  const expected = { entrypoint: '0x5555555555555555555555555555555555555555', poolVault: '0x6666666666666666666666666666666666666666' };
  const facts = (nativeMode?: boolean) => ({ vault: PP_ETH, entrypoint: expected.entrypoint, poolVault: expected.poolVault, nativeMode });

  test('a native deployment needs a router that says NATIVE_MODE', () => {
    expect(routerMatches(facts(true), { ppUSDC: PP_ETH, ppRouter: ROUTER, nativeMode: true }, expected)).toBe(true);
    expect(routerMatches(facts(false), { ppUSDC: PP_ETH, ppRouter: ROUTER, nativeMode: true }, expected)).toBe(false);
  });

  // An unreadable NATIVE_MODE is the pre-ppETH world: every router deployed
  // before the getter existed is an ERC-20 router. Tolerated there, fatal here.
  test('an unreadable NATIVE_MODE fails a native deployment and passes an ERC-20 one', () => {
    expect(routerMatches(facts(undefined), { ppUSDC: PP_ETH, ppRouter: ROUTER, nativeMode: true }, expected)).toBe(false);
    expect(routerMatches(facts(undefined), { ppUSDC: PP_ETH, ppRouter: ROUTER }, expected)).toBe(true);
  });

  test('an ERC-20 deployment over a native router is refused too', () => {
    expect(routerMatches(facts(true), { ppUSDC: PP_ETH, ppRouter: ROUTER }, expected)).toBe(false);
  });
});
