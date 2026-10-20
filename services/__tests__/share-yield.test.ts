import { describe, expect, test } from 'bun:test';
import {
  AAVE_ATOKEN_ABI,
  AAVE_POOL_ABI,
  SHARE_VAULT_ABI,
  fetchShareYield,
  formatApyPercent,
  getYieldShareToken,
  shareApyFromAave,
  type ShareYieldReader,
} from '@/services/share-yield';
import { ENVIRONMENTS } from '@/config/environments';

// Live values read on 2026-09-04 (cast): mainnet Aave v3 USDC
// currentLiquidityRate and the ppUSDC wrapper's feeBps; BSC USDT likewise.
const MAINNET_USDC_RATE = 35406722171264961896401431n;
const BSC_USDT_RATE = 26795849638335151851945247n;

describe('shareApyFromAave', () => {
  test('mainnet ppUSDC: 3.54% APR compounds to ~3.60% gross, 20% fee leaves ~2.88% net', () => {
    const apy = shareApyFromAave({ liquidityRateRay: MAINNET_USDC_RATE, feeBps: 2000n })!;
    expect(apy.grossApyPercent).toBeCloseTo(3.604, 2);
    expect(apy.netApyPercent).toBeCloseTo(2.883, 2);
    expect(apy.feeBps).toBe(2000);
  });

  test('BSC ppUSDT: a different rate gives a different figure (not a constant)', () => {
    const apy = shareApyFromAave({ liquidityRateRay: BSC_USDT_RATE, feeBps: 2000n })!;
    expect(apy.grossApyPercent).toBeCloseTo(2.716, 2);
    expect(apy.netApyPercent).toBeCloseTo(2.173, 2);
    expect(apy.netApyPercent).toBeLessThan(shareApyFromAave({ liquidityRateRay: MAINNET_USDC_RATE, feeBps: 2000n })!.netApyPercent);
  });

  test('zero fee: net equals gross; zero rate: both zero', () => {
    const free = shareApyFromAave({ liquidityRateRay: MAINNET_USDC_RATE, feeBps: 0n })!;
    expect(free.netApyPercent).toBe(free.grossApyPercent);
    const idle = shareApyFromAave({ liquidityRateRay: 0n, feeBps: 2000n })!;
    expect(idle.grossApyPercent).toBe(0);
    expect(idle.netApyPercent).toBe(0);
  });

  test('a fee of 100% or more, or a negative input, is not a rate: null, so the figure is omitted', () => {
    expect(shareApyFromAave({ liquidityRateRay: MAINNET_USDC_RATE, feeBps: 10_000n })).toBeNull();
    expect(shareApyFromAave({ liquidityRateRay: MAINNET_USDC_RATE, feeBps: 12_000n })).toBeNull();
    expect(shareApyFromAave({ liquidityRateRay: -1n, feeBps: 0n })).toBeNull();
    expect(shareApyFromAave({ liquidityRateRay: MAINNET_USDC_RATE, feeBps: -1n })).toBeNull();
  });
});

describe('fetchShareYield', () => {
  const SHARE = '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6' as const;
  const ATOKEN = '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c' as const;
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
  const POOL = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' as const;

  function fakeReader(calls: Array<{ address: string; functionName: string; args?: unknown }>): ShareYieldReader {
    return {
      readContract: (async (req: { address: string; abi: unknown; functionName: string; args?: unknown }) => {
        calls.push({ address: req.address, functionName: req.functionName, args: req.args });
        if (req.abi === SHARE_VAULT_ABI && req.functionName === 'asset') return ATOKEN;
        if (req.abi === SHARE_VAULT_ABI && req.functionName === 'feeBps') return 2000n;
        if (req.abi === AAVE_ATOKEN_ABI && req.functionName === 'UNDERLYING_ASSET_ADDRESS') return USDC;
        if (req.abi === AAVE_ATOKEN_ABI && req.functionName === 'POOL') return POOL;
        if (req.abi === AAVE_POOL_ABI && req.functionName === 'getReserveData') return { currentLiquidityRate: MAINNET_USDC_RATE };
        throw new Error(`unexpected read ${req.functionName}`);
      }) as ShareYieldReader['readContract'],
    };
  }

  test('follows share -> aToken -> (underlying, pool) -> reserve, and only ever names public asset addresses', async () => {
    const calls: Array<{ address: string; functionName: string; args?: unknown }> = [];
    const result = await fetchShareYield(fakeReader(calls), SHARE);
    expect(result).not.toBeNull();
    expect(result!.share).toBe(SHARE);
    expect(result!.aToken).toBe(ATOKEN);
    expect(result!.underlying).toBe(USDC);
    expect(result!.aavePool).toBe(POOL);
    expect(result!.netApyPercent).toBeCloseTo(2.883, 2);
    expect(calls.map((c) => c.functionName).sort()).toEqual(['POOL', 'UNDERLYING_ASSET_ADDRESS', 'asset', 'feeBps', 'getReserveData']);
    expect(calls.find((c) => c.functionName === 'getReserveData')).toEqual({ address: POOL, functionName: 'getReserveData', args: [USDC] });
    // Every address the reader saw is one of the four public asset contracts.
    for (const c of calls) expect([SHARE, ATOKEN, POOL]).toContain(c.address);
  });

  test('an RPC failure propagates (the hook keeps null, the surfaces omit the figure)', async () => {
    const reader: ShareYieldReader = { readContract: (async () => { throw new Error('HTTP 429'); }) as ShareYieldReader['readContract'] };
    await expect(fetchShareYield(reader, SHARE)).rejects.toThrow('HTTP 429');
  });
});

describe('getYieldShareToken', () => {
  test('only a token flagged yieldShare qualifies, matched case-insensitively; a plain asset never does', () => {
    const prod = ENVIRONMENTS.prod;
    const share = getYieldShareToken(1, '0xc246afb23482ff9596e9cee5f1f678efe0eb1ad6', prod);
    expect(share?.symbol).toBe('ppUSDC');
    expect(getYieldShareToken(1, '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', prod)).toBeUndefined();
    expect(getYieldShareToken(56, '0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409', prod)).toBeUndefined(); // FDUSD: plain
    expect(getYieldShareToken(undefined, '0xc246afb23482ff9596e9cee5f1f678efe0eb1ad6', prod)).toBeUndefined();
    expect(getYieldShareToken(1, undefined, prod)).toBeUndefined();
    // Staging has no share tokens at all, so the same address is a plain asset there.
    expect(getYieldShareToken(1, '0xc246afb23482ff9596e9cee5f1f678efe0eb1ad6', ENVIRONMENTS.staging)).toBeUndefined();
  });
});

describe('formatApyPercent', () => {
  test('two decimals, en-US, no trailing garbage', () => {
    expect(formatApyPercent(2.8834)).toBe('2.88');
    expect(formatApyPercent(3)).toBe('3.00');
    expect(formatApyPercent(0)).toBe('0.00');
  });
});
