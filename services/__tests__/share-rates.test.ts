import { describe, expect, test } from 'bun:test';
import { formatShareAsUnderlying, shareExactAsUnderlying, shareNumberAsUnderlying, shareRateKey, underlyingPriceFor, type ShareRate } from '@/services/share-rates';
import { formatUsd } from '@/services/format-fiat';

// The mainnet ppUSDC vault on 2026-09-05: 1 ppUSDC = 1.000103 USDC.
const RATE: ShareRate = {
  chainId: 1,
  share: '0xc246afb23482ff9596e9cee5f1f678efe0eb1ad6',
  underlying: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  shareSymbol: 'ppUSDC',
  shareDecimals: 18,
  assetsPerShare: 1_000_103n,
  underlyingSymbol: 'USDC',
  underlyingDecimals: 6,
};

describe('share rates', () => {
  test('a share balance reads as the USDC it is worth, at the live rate', () => {
    // Pat's row: 38.10 ppUSDC / 109.59 ppUSDC pending.
    expect(shareExactAsUnderlying('38.1', RATE)).toBeCloseTo(38.103924, 5);
    expect(formatShareAsUnderlying(shareExactAsUnderlying('38.1', RATE)!, RATE)).toBe('38.10 USDC');
    expect(formatShareAsUnderlying(shareExactAsUnderlying('109.59', RATE)!, RATE)).toBe('109.60 USDC');
    // integer math: full-precision strings and dust survive
    expect(shareExactAsUnderlying('0.000000000000000001', RATE)).toBe(0);
    expect(shareExactAsUnderlying('', RATE)).toBe(0);
    // not a decimal string: null, so the row keeps its share count instead of a false 0.00
    expect(shareExactAsUnderlying('not a number', RATE)).toBeNull();
    expect(shareExactAsUnderlying('1e3', RATE)).toBeNull();
    // full formatUnits precision round-trips
    expect(shareExactAsUnderlying('1.234567890123456789', RATE)).toBeCloseTo(1.234695, 6);
  });
  test('the activity rows convert their numeric share amounts the same way', () => {
    expect(shareNumberAsUnderlying(30, RATE)).toBeCloseTo(30.00309, 5);
    expect(formatShareAsUnderlying(shareNumberAsUnderlying(29.9969, RATE), RATE)).toBe('30 USDC');
    expect(shareNumberAsUnderlying(Number.NaN, RATE)).toBe(0);
  });
  test('keys are chain-scoped and case-insensitive', () => {
    expect(shareRateKey(1, '0xC246AFB23482FF9596E9CEE5F1F678EFE0EB1AD6')).toBe(`1:${RATE.share}`);
  });
});

describe('the dollar figure follows the converted amount', () => {
  test('amount and USD agree at a cent boundary', () => {
    const converted = shareExactAsUnderlying('109.59', RATE)!;
    expect(formatShareAsUnderlying(converted, RATE)).toBe('109.60 USDC');
    // the dollar column prints whole dollars above $100, like every other row
    expect(formatUsd(converted * underlyingPriceFor(RATE, { usdc: 1 }))).toBe(formatUsd(109.5999));
  });
  test('the underlying price comes from the map by address, then symbol, then $1 for a stablecoin', () => {
    expect(underlyingPriceFor(RATE, { [RATE.underlying]: 0.999 })).toBe(0.999);
    expect(underlyingPriceFor(RATE, { USDC: 1.001 })).toBe(1.001);
    expect(underlyingPriceFor(RATE, {})).toBe(1);
    expect(underlyingPriceFor({ ...RATE, underlyingSymbol: 'WETH' }, undefined)).toBe(0);
  });
  test('a WETH underlying reads and prices as ETH, the coin the router wraps (ppETH, 2026-09-18)', () => {
    const weth: ShareRate = { ...RATE, share: '0x66051920d25af4e3596a8a46309f4d045f9d83b7', shareSymbol: 'ppETH', underlying: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', underlyingSymbol: 'WETH', assetsPerShare: 1_000_000n };
    expect(formatShareAsUnderlying(shareExactAsUnderlying('0.00401', weth)!, weth)).toBe('0.00401 ETH');
    expect(underlyingPriceFor(weth, { ETH: 4200 })).toBe(4200);
    expect(underlyingPriceFor(weth, { WETH: 4199 })).toBe(4199);
    expect(underlyingPriceFor(weth, {})).toBe(0);
  });
  test('a below-par rate and a ppUSDT vault convert without clamping', () => {
    const below: ShareRate = { ...RATE, assetsPerShare: 999_999n };
    expect(shareExactAsUnderlying('100', below)).toBeCloseTo(99.9999, 6);
    const usdt: ShareRate = { ...RATE, share: '0xa4cf419558ef36cc6ffb666195684dc963910426', shareSymbol: 'ppUSDT', underlyingSymbol: 'USDT', assetsPerShare: 1_000_026n };
    expect(formatShareAsUnderlying(shareExactAsUnderlying('49.75', usdt)!, usdt)).toBe('49.75 USDT');
  });
});
