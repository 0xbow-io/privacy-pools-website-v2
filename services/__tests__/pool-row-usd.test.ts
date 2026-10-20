/**
 * Prod, 2026-09-22. "My private balance" read $9 over rows of cBTC $9, ETH $14
 * and USDC $0. The hero was the sum of the rows it did not show.
 *
 * A share cannot be priced by its own symbol. There is no "ppETH" in the price
 * feed, so the lookup fell to the stablecoin floor, which is 0 for anything
 * that is not a stablecoin, and both share rows counted as zero. The balances
 * CARD already converted each share to its underlying and priced that, which is
 * why the rows were right while the total was not.
 *
 * The numbers below are Mike's.
 */
import { describe, expect, test } from 'bun:test';
import { parseUnits } from 'viem';
import { rowUsd } from '@/services/pool-row-usd';
import type { ShareRate } from '@/services/share-rates';

/** ppETH at ~1.0 WETH per share, which is what the vault reports. */
const PP_ETH_RATE: ShareRate = {
  chainId: 1,
  share: '0x66051920D25af4E3596A8a46309F4D045F9D83B7',
  underlying: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  underlyingSymbol: 'WETH',
  underlyingDecimals: 18,
  assetsPerShare: parseUnits('1', 18),
} as ShareRate;

/** ppUSDC at 1.02 USDC per share: a share is NOT one-for-one with its underlying. */
const PP_USDC_RATE: ShareRate = {
  chainId: 1,
  share: '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6',
  underlying: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  underlyingSymbol: 'USDC',
  underlyingDecimals: 6,
  assetsPerShare: parseUnits('1.02', 6),
} as ShareRate;

// The feed carries plain symbols and addresses. It does NOT carry 'ppETH'.
const PRICES: Record<string, number> = { ETH: 2750, WETH: 2750, USDC: 1, CBTC: 82_000 };

describe('a share is priced through its underlying', () => {
  test("Mike's ETH row: 0.005 ppETH is $14, not $0", () => {
    const usd = rowUsd({ amount: 0.005, rate: PP_ETH_RATE, plainPrice: 0, priceMap: PRICES });
    expect(Math.round(usd)).toBe(14);
  });

  test('what the old arithmetic did with the same row', () => {
    // priceMap['ppETH'] is undefined, and ppETH is not a stablecoin, so the
    // symbol path floors to 0 and the row vanishes from the total.
    expect(PRICES['ppETH']).toBeUndefined();
    expect(0.005 * 0).toBe(0);
  });

  test('the rate is applied, not assumed to be one-for-one', () => {
    // 100 ppUSDC at 1.02 is $102, not $100.
    expect(rowUsd({ amount: 100, rate: PP_USDC_RATE, plainPrice: 0, priceMap: PRICES })).toBeCloseTo(102, 6);
  });

  test('a plain asset keeps its own price', () => {
    expect(rowUsd({ amount: 0.00011, plainPrice: 82_000, priceMap: PRICES })).toBeCloseTo(9.02, 2);
  });

  test("the hero equals the sum of Mike's rows", () => {
    const cbtc = rowUsd({ amount: 0.00011, plainPrice: 82_000, priceMap: PRICES });
    const eth = rowUsd({ amount: 0.005, rate: PP_ETH_RATE, plainPrice: 0, priceMap: PRICES });
    const usdc = rowUsd({ amount: 0, rate: PP_USDC_RATE, plainPrice: 0, priceMap: PRICES });
    // $23, which is what the screen should have said. It said $9.
    expect(Math.round(cbtc + eth + usdc)).toBe(23);
  });
});

describe('it refuses to invent a number', () => {
  test('a share whose underlying has no price reads 0, never shares times something else', () => {
    // Pricing 0.005 ppETH with a stray 2750 that belongs to a different asset
    // would put $14 on screen for a quantity nobody priced.
    expect(rowUsd({ amount: 0.005, rate: PP_ETH_RATE, plainPrice: 2750, priceMap: {} })).toBe(0);
  });

  test('a share with no rate yet reads 0 and corrects when the rate lands', () => {
    expect(rowUsd({ amount: 0.005, rate: undefined, plainPrice: 0, priceMap: PRICES })).toBe(0);
    expect(Math.round(rowUsd({ amount: 0.005, rate: PP_ETH_RATE, plainPrice: 0, priceMap: PRICES }))).toBe(14);
  });

  test('a non-finite amount is 0, so one bad row cannot poison the total', () => {
    expect(rowUsd({ amount: NaN, plainPrice: 2750, priceMap: PRICES })).toBe(0);
    expect(rowUsd({ amount: Infinity, plainPrice: 2750, priceMap: PRICES })).toBe(0);
  });
});
