import { describe, expect, test } from 'bun:test';
import { parseYieldDeploymentMap, resolveYieldDeployment } from '../../config/yield';

const VALID = {
  ppRouter: '0x08e984a00E5575b366310f3dE7f53135e139F1b1',
  ppUSDC: '0x305E689dc6659273CAD6F5b43Ae4001f39D2519d',
  ppUSDCDecimals: 18,
  underlying: '0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8',
  underlyingDecimals: 6,
  underlyingSymbol: 'USDC',
  apyLabel: 'Aave',
};
const ZERO = '0x0000000000000000000000000000000000000000';

describe('parseYieldDeploymentMap', () => {
  test('parses a valid single-chain map', () => {
    const map = parseYieldDeploymentMap(JSON.stringify({ 11155111: VALID }));
    expect(map[11155111]?.ppRouter).toBe(VALID.ppRouter as `0x${string}`);
    expect(map[11155111]?.underlyingSymbol).toBe('USDC');
    expect(map[11155111]?.apyLabel).toBe('Aave');
  });

  test('empty / undefined env yields an empty map', () => {
    expect(parseYieldDeploymentMap(undefined)).toEqual({});
    expect(parseYieldDeploymentMap('')).toEqual({});
  });

  test('malformed JSON fails closed', () => {
    expect(parseYieldDeploymentMap('{not json')).toEqual({});
  });

  test('non-object JSON fails closed', () => {
    expect(parseYieldDeploymentMap('[1,2,3]')).toEqual({});
    expect(parseYieldDeploymentMap('"str"')).toEqual({});
  });

  test('invalid addresses fail closed per entry', () => {
    const map = parseYieldDeploymentMap(JSON.stringify({
      11155111: { ...VALID, ppRouter: '0x123' },
      1: VALID,
    }));
    expect(map[11155111]).toBeUndefined();
    expect(map[1]).toBeDefined();
  });

  test('zero address fails closed (codex finding 9)', () => {
    expect(parseYieldDeploymentMap(JSON.stringify({ 11155111: { ...VALID, ppUSDC: ZERO } }))[11155111]).toBeUndefined();
    expect(parseYieldDeploymentMap(JSON.stringify({ 11155111: { ...VALID, ppRouter: ZERO } }))[11155111]).toBeUndefined();
    expect(parseYieldDeploymentMap(JSON.stringify({ 11155111: { ...VALID, underlying: ZERO } }))[11155111]).toBeUndefined();
  });

  test('missing decimals / symbol fail closed', () => {
    const { underlyingSymbol: _drop, ...noSymbol } = VALID;
    const map = parseYieldDeploymentMap(JSON.stringify({ 11155111: noSymbol }));
    expect(map[11155111]).toBeUndefined();
  });

  test('share decimals below underlying decimals fail closed', () => {
    const map = parseYieldDeploymentMap(JSON.stringify({ 11155111: { ...VALID, ppUSDCDecimals: 4 } }));
    expect(map[11155111]).toBeUndefined();
  });

  test('negative / non-integer / out-of-range decimals fail closed (codex finding 9)', () => {
    expect(parseYieldDeploymentMap(JSON.stringify({ 1: { ...VALID, underlyingDecimals: -1 } }))[1]).toBeUndefined();
    expect(parseYieldDeploymentMap(JSON.stringify({ 1: { ...VALID, underlyingDecimals: 2.5 } }))[1]).toBeUndefined();
    expect(parseYieldDeploymentMap(JSON.stringify({ 1: { ...VALID, ppUSDCDecimals: 999 } }))[1]).toBeUndefined();
  });

  test('an unreasonable ppUSDC-underlying decimal gap fails closed (finding 9)', () => {
    // 36 - 0 = 36 > 30 cap
    const map = parseYieldDeploymentMap(JSON.stringify({ 1: { ...VALID, ppUSDCDecimals: 36, underlyingDecimals: 0 } }));
    expect(map[1]).toBeUndefined();
  });

  test('non-integer chainId key fails closed', () => {
    expect(parseYieldDeploymentMap(JSON.stringify({ 'abc': VALID }))).toEqual({});
  });
});

describe('resolveYieldDeployment (single fail-closed gate)', () => {
  const map = parseYieldDeploymentMap(JSON.stringify({ 11155111: VALID }));
  const ready = { enabled: true, withdrawReady: true };

  test('flag OFF hides a fully configured deployment', () => {
    expect(resolveYieldDeployment(11155111, { enabled: false, withdrawReady: true }, map)).toBeUndefined();
  });

  test('withdraw NOT ready hides the deployment even with the flag on (codex P0)', () => {
    expect(resolveYieldDeployment(11155111, { enabled: true, withdrawReady: false }, map)).toBeUndefined();
  });

  test('fully enabled resolves the configured chain only', () => {
    expect(resolveYieldDeployment(11155111, ready, map)?.ppUSDC).toBe(VALID.ppUSDC as `0x${string}`);
    expect(resolveYieldDeployment(1, ready, map)).toBeUndefined();
  });
});

describe('several deployments per chain (2026-09-04)', () => {
  const SECOND = {
    ...VALID,
    ppUSDC: '0xA4cF419558Ef36CC6FfB666195684dC963910426',
    underlying: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    underlyingSymbol: 'USDT',
  };
  const json = JSON.stringify({ 1: [VALID, SECOND], 56: SECOND });
  const yieldMod = require('../../config/yield') as typeof import('../../config/yield');

  test('an array per chain parses every entry; an object still parses as one', () => {
    const map = yieldMod.parseYieldDeploymentsMap(json);
    expect(map[1]?.map((d) => d.underlyingSymbol)).toEqual(['USDC', 'USDT']);
    expect(map[56]?.map((d) => d.underlyingSymbol)).toEqual(['USDT']);
    // The single-deployment view is the first entry, so existing callers see what they always saw.
    expect(yieldMod.parseYieldDeploymentMap(json)[1]?.underlyingSymbol).toBe('USDC');
  });
  test('a second entry naming the same share is dropped, and an invalid entry fails closed alone', () => {
    const dupe = JSON.stringify({ 1: [VALID, { ...VALID, underlyingSymbol: 'DUPE' }, { ...SECOND, ppRouter: ZERO }, SECOND] });
    expect(yieldMod.parseYieldDeploymentsMap(dupe)[1]?.map((d) => d.underlyingSymbol)).toEqual(['USDC', 'USDT']);
  });
  test('resolveYieldDeploymentForAsset picks by underlying or share, only when that share is verified', () => {
    const map = yieldMod.parseYieldDeploymentsMap(json);
    const on = { enabled: true, withdrawReady: true };
    const usable = (_c: number, share: string) => share.toLowerCase() === SECOND.ppUSDC.toLowerCase();
    expect(yieldMod.resolveYieldDeploymentForAsset(1, SECOND.underlying.toLowerCase(), on, map, usable)?.underlyingSymbol).toBe('USDT');
    expect(yieldMod.resolveYieldDeploymentForAsset(1, SECOND.ppUSDC, on, map, usable)?.underlyingSymbol).toBe('USDT');
    // USDC's vault is not verified: no deployment, never "the other one".
    expect(yieldMod.resolveYieldDeploymentForAsset(1, VALID.underlying, on, map, usable)).toBeUndefined();
    expect(yieldMod.resolveYieldDeploymentForAsset(1, undefined, on, map, usable)).toBeUndefined();
    expect(yieldMod.resolveYieldDeploymentForAsset(1, SECOND.underlying, { enabled: false, withdrawReady: true }, map, usable)).toBeUndefined();
    expect(yieldMod.resolveYieldDeployments(1, on, map)).toHaveLength(2);
    expect(yieldMod.resolveYieldDeployments(1, { enabled: true, withdrawReady: false }, map)).toEqual([]);
  });
  test('two verified shares resolve by exact underlying while share inputs stay on the plain deposit path', () => {
    const map = yieldMod.parseYieldDeploymentsMap(json);
    const on = { enabled: true, withdrawReady: true };
    const usable = () => true;
    expect(yieldMod.resolveYieldDepositDeploymentForUnderlying(1, VALID.underlying, on, map, usable)?.ppUSDC)
      .toBe(VALID.ppUSDC);
    expect(yieldMod.resolveYieldDepositDeploymentForUnderlying(1, SECOND.underlying, on, map, usable)?.ppUSDC)
      .toBe(SECOND.ppUSDC);
    expect(yieldMod.resolveYieldDepositDeploymentForUnderlying(1, VALID.ppUSDC, on, map, usable)).toBeUndefined();
    expect(yieldMod.resolveYieldDepositDeploymentForUnderlying(1, SECOND.ppUSDC, on, map, usable)).toBeUndefined();
  });
});

describe('mergeYieldDeploymentMaps', () => {
  test('the env JSON overrides per chain and never erases a chain it does not name', () => {
    const { mergeYieldDeploymentMaps } = require('../../config/yield') as typeof import('../../config/yield');
    const D = VALID as unknown as import('../../services/sdk-types').YieldDeployment;
    const defaults = { 1: [D], 56: [{ ...D, underlyingSymbol: 'USDT' }] };
    const env = { 11155111: [{ ...D, underlyingSymbol: 'SEP' }], 56: [{ ...D, underlyingSymbol: 'ENV' }] };
    const merged = mergeYieldDeploymentMaps(defaults, env);
    expect(Object.keys(merged).map(Number).sort((a, b) => a - b)).toEqual([1, 56, 11155111]);
    expect(merged[1]?.[0]?.underlyingSymbol).toBe('USDC');
    expect(merged[56]?.[0]?.underlyingSymbol).toBe('ENV');
    expect(mergeYieldDeploymentMaps(undefined, env)).toEqual(env);
    expect(mergeYieldDeploymentMaps(defaults, {})).toEqual(defaults);
  });
});

describe('prod router allowlist + underlying uniqueness (codex, 2026-09-04)', () => {
  const yieldMod = require('../../config/yield') as typeof import('../../config/yield');
  const D = VALID as unknown as import('../../services/sdk-types').YieldDeployment;
  test('an env entry for a locked chain is ignored unless it names the same router + share; unlocked chains still take the env', () => {
    const defaults = { 1: [D] };
    const rogue = { ...D, ppRouter: '0x1111111111111111111111111111111111111111' as `0x${string}` };
    expect(yieldMod.mergeYieldDeploymentMaps(defaults, { 1: [rogue] }, [1])[1]).toEqual([D]);
    expect(yieldMod.mergeYieldDeploymentMaps(defaults, { 1: [{ ...D, apyLabel: 'same addresses' }] }, [1])[1]).toEqual([D]);
    expect(yieldMod.mergeYieldDeploymentMaps(defaults, { 1: [rogue] }, [])[1]).toEqual([rogue]);
    expect(yieldMod.mergeYieldDeploymentMaps(defaults, { 56: [rogue] }, [1])[56]).toEqual([rogue]);
  });
  test('"1" and "01" are one chain; a second deployment for the same underlying is dropped', () => {
    const other = { ...VALID, ppUSDC: '0xA4cF419558Ef36CC6FfB666195684dC963910426' };
    const map = yieldMod.parseYieldDeploymentsMap(JSON.stringify({ '1': [VALID], '01': [VALID, other] }));
    expect(Object.keys(map)).toEqual(['1']);
    expect(map[1]).toHaveLength(1);
  });
});
