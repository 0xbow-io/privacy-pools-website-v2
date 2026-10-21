import { describe, expect, test } from 'bun:test';
import { shareBalanceDisplay } from '@/services/share-balance-display';
import type { ShareRate } from '@/services/share-rates';

// Mainnet ppETH on 2026-10-21: 1 ppETH = 1.001094122102504299 WETH.
const PP_ETH: ShareRate = {
  chainId: 1,
  share: '0x66051920d25af4e3596a8a46309f4d045f9d83b7',
  underlying: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  shareSymbol: 'ppETH',
  shareDecimals: 18,
  assetsPerShare: 1_001_094_122_102_504_299n,
  underlyingSymbol: 'WETH',
  underlyingDecimals: 18,
};
// ppUSDC: 18-decimal share over 6-decimal USDC.
const PP_USDC: ShareRate = {
  chainId: 1,
  share: '0xc246afb23482ff9596e9cee5f1f678efe0eb1ad6',
  underlying: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  shareSymbol: 'ppUSDC',
  shareDecimals: 18,
  assetsPerShare: 1_000_103n,
  underlyingSymbol: 'USDC',
  underlyingDecimals: 6,
};
const PRICES = { ETH: 2459 };

describe('shareBalanceDisplay', () => {
  test('0.09989 ppETH shares read as the 0.10 ETH they are worth, USD from the ETH price', () => {
    const v = shareBalanceDisplay({ sharesExact: '0.09989', shareSymbol: 'ppETH', rate: PP_ETH, priceMap: PRICES, fallbackPrice: 0 });
    expect(v.converted).toBe(true);
    expect(v.symbol).toBe('ETH');
    expect(v.text).toBe('0.10 ETH');
    expect(v.amount).toBeCloseTo(0.09989 * 1.001094122, 8);
    expect(v.usd).toBeCloseTo(v.amount * 2459, 6);
    // not the old shares x price figure
    expect(v.usd).toBeGreaterThan(0.09989 * 2459);
  });

  test('the hint names the share count under the share symbol and the worth', () => {
    const v = shareBalanceDisplay({ sharesExact: '0.09989', shareSymbol: 'ppETH', rate: PP_ETH, priceMap: PRICES, fallbackPrice: 0 });
    expect(v.hint).toBe('0.09989 ppETH shares, worth 0.10 ETH today. Shares keep their count, their value grows as yield accrues.');
    expect(v.hint).not.toContain('—');
  });

  test('no rate: the share count under the SHARE symbol, never labelled ETH', () => {
    const v = shareBalanceDisplay({ sharesExact: '0.09989', shareSymbol: 'ppETH', rate: undefined, priceMap: PRICES, fallbackPrice: 2459 });
    expect(v.converted).toBe(false);
    expect(v.text).toBe('0.09989 ppETH');
    expect(v.hint).toBeNull();
    expect(v.usd).toBeCloseTo(0.09989 * 2459, 6);
  });

  test('nothing held keeps the coin name, never "0 ppETH"', () => {
    const none = shareBalanceDisplay({ sharesExact: '0', shareSymbol: 'ppETH', rate: undefined, priceMap: PRICES, fallbackPrice: 2459 });
    expect(none.text).toBe('0.00 ETH');
    expect(none.hint).toBeNull();
    const converted = shareBalanceDisplay({ sharesExact: '0', shareSymbol: 'ppETH', rate: PP_ETH, priceMap: PRICES, fallbackPrice: 0 });
    expect(converted.text).toBe('0.00 ETH');
    expect(converted.hint).toBeNull();
  });

  test('ppUSDC: 18-decimal shares convert into 6-decimal USDC without mixing decimals', () => {
    const v = shareBalanceDisplay({ sharesExact: '38.1', shareSymbol: 'ppUSDC', rate: PP_USDC, priceMap: {}, fallbackPrice: 0 });
    expect(v.text).toBe('38.10 USDC');
    expect(v.amount).toBeCloseTo(38.103924, 5);
    // a stablecoin with no quote is $1
    expect(v.usd).toBeCloseTo(38.103924, 5);
    expect(v.hint).toBe('38.10 ppUSDC shares, worth 38.10 USDC today. Shares keep their count, their value grows as yield accrues.');
  });

  test('a string that is not a plain decimal never becomes a share count', () => {
    const v = shareBalanceDisplay({ sharesExact: '1e3', shareSymbol: 'ppUSDC', rate: PP_USDC, priceMap: {}, fallbackPrice: 1 });
    expect(v.converted).toBe(false);
    expect(v.amount).toBe(0);
    expect(v.usd).toBe(0);
    expect(v.text).toBe('0 USDC');
  });
});
