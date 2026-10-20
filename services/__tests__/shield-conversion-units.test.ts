/**
 * Prod, 2026-09-22: paying 0.005 ETH (about $13.74) into the mainnet USDC pool
 * previewed as "0" and was refused with "Minimum deposit is 10 USDC".
 *
 * The conversion quote delivers the pool's UNDERLYING, because no DEX holds the
 * share, so `toAmount` came back as 13_740_000 in 6-decimal USDC. Every
 * consumer read it with the SHARE's 18 decimals: the preview divided it by
 * 1e12 and printed 0, the minimum check compared it against 10e18 and refused,
 * and the deposit sizing would have asked for dust.
 *
 * These assertions run against the shipped module rather than a copy of the
 * rule, which is the mistake shield-pay-routing.test.ts records having made
 * twice: a reproduced predicate keeps passing after the component is fixed.
 */
import { describe, expect, test } from 'bun:test';
import { formatUnits, parseUnits } from 'viem';
import { conversionBelowMinimum, conversionFundingUnits } from '@/services/shield-conversion-units';

const PP_USDC = { decimals: 18, symbol: 'ppUSDC' };
const USDC_DEPLOYMENT = { underlyingDecimals: 6, underlyingSymbol: 'USDC', ppUSDCDecimals: 18 };
const ETH_DEPLOYMENT = { underlyingDecimals: 18, underlyingSymbol: 'WETH', ppUSDCDecimals: 18, nativeMode: true };

describe('conversionFundingUnits', () => {
  test('a wrapped pool is funded in its underlying, not in its share', () => {
    expect(conversionFundingUnits(USDC_DEPLOYMENT, PP_USDC)).toEqual({ decimals: 6, symbol: 'USDC' });
  });

  test('a plain pool funds itself', () => {
    const plain = { decimals: 18, symbol: 'BNB' };
    expect(conversionFundingUnits(null, plain)).toEqual(plain);
    expect(conversionFundingUnits(undefined, plain)).toEqual(plain);
  });

  test('a native-mode router takes the coin, 18 decimals like the share', () => {
    expect(conversionFundingUnits(ETH_DEPLOYMENT, { decimals: 18, symbol: 'ppETH' }))
      .toEqual({ decimals: 18, symbol: 'ppETH' });
  });

  // The regression itself, as a number the reader can check by eye.
  test('the live figure renders as 13.74 USDC, not as 0', () => {
    const quoted = 13_740_000n; // what LiFi delivered for 0.005 ETH
    const units = conversionFundingUnits(USDC_DEPLOYMENT, PP_USDC);
    expect(formatUnits(quoted, units.decimals)).toBe('13.74');
    // What it used to do, kept here so the failure is legible if it returns.
    expect(parseFloat(formatUnits(quoted, PP_USDC.decimals))).toBeLessThan(0.000001);
  });
});

describe('conversionBelowMinimum', () => {
  const minUnderlying = parseUnits('10', 6); // the entrypoint minimum, in USDC

  test('13.74 USDC clears a 10 USDC minimum', () => {
    expect(conversionBelowMinimum(13_740_000n, minUnderlying)).toBe(false);
  });

  test('the old comparison, share-denominated minimum, is what refused it', () => {
    // 13_740_000 < 10e18 is trivially true: this is the bug, pinned so that
    // anyone reintroducing the share minimum here sees which line to look at.
    expect(13_740_000n < parseUnits('10', 18)).toBe(true);
  });

  test('a genuinely small conversion is still refused', () => {
    expect(conversionBelowMinimum(9_999_999n, minUnderlying)).toBe(true);
    expect(conversionBelowMinimum(0n, minUnderlying)).toBe(true);
  });

  test('exactly the minimum is allowed', () => {
    expect(conversionBelowMinimum(minUnderlying, minUnderlying)).toBe(false);
  });

  // A pending previewMint must not read as a refusal: that would put a red
  // "below minimum" line under an amount that is fine, while it is still being
  // priced.
  test('nothing is judged until both figures exist', () => {
    expect(conversionBelowMinimum(null, minUnderlying)).toBe(false);
    expect(conversionBelowMinimum(13_740_000n, null)).toBe(false);
    expect(conversionBelowMinimum(undefined, undefined)).toBe(false);
    expect(conversionBelowMinimum(13_740_000n, 0n)).toBe(false);
  });
});
