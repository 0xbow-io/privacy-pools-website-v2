// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay; the (i) hint
// names only the worth. Share counts appear only in fields labelled with the
// share symbol, or while the rate is unknown.
// Never print a share count under the underlying symbol.
import { describe, expect, test } from 'bun:test';
import { shareBalanceDisplay } from '@/services/share-balance-display';
import { parseTokenAmount } from '@/services/token-amount';
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
  test('0.09989 ppETH reads as the ETH it is worth, rounded down, USD from the ETH price', () => {
    const v = shareBalanceDisplay({ sharesExact: '0.09989', shareSymbol: 'ppETH', rate: PP_ETH, priceMap: PRICES, fallbackPrice: 0 });
    expect(v.converted).toBe(true);
    expect(v.symbol).toBe('ETH');
    expect(v.text).toBe('0.09999 ETH');
    expect(v.amount).toBeCloseTo(0.09989 * 1.001094122, 8);
    expect(v.usd).toBeCloseTo(v.amount * 2459, 6);
    // not the old shares x price figure
    expect(v.usd).toBeGreaterThan(0.09989 * 2459);
  });

  test('the hint names only the worth, never a share count or the word shares', () => {
    const v = shareBalanceDisplay({ sharesExact: '0.09989', shareSymbol: 'ppETH', rate: PP_ETH, priceMap: PRICES, fallbackPrice: 0 });
    expect(v.hint).toBe('Worth 0.09999 ETH today. The value grows as yield accrues.');
    expect(v.hint).not.toContain('—');
    expect(v.hint).not.toMatch(/shares?/i);
    expect(v.hint).not.toContain('ppETH');
  });

  test('no rate: loading under the coin name, never the count and never the share symbol (DEV-621)', () => {
    const v = shareBalanceDisplay({ sharesExact: '0.09989', shareSymbol: 'ppETH', rate: undefined, priceMap: PRICES, fallbackPrice: 2459 });
    expect(v.converted).toBe(false);
    expect(v.loading).toBe(true);
    expect(v.text).toBe('… ETH');
    expect(v.text).not.toContain('0.09989');
    expect(v.symbol).toBe('ETH');
    expect(v.hint).toBeNull();
    expect(v.usd).toBe(0);
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
    expect(v.hint).toBe('Worth 38.10 USDC today. The value grows as yield accrues.');
  });

  test('a string that is not a plain decimal never becomes a share count', () => {
    const v = shareBalanceDisplay({ sharesExact: '1e3', shareSymbol: 'ppUSDC', rate: PP_USDC, priceMap: {}, fallbackPrice: 1 });
    expect(v.converted).toBe(false);
    expect(v.amount).toBe(0);
    expect(v.usd).toBe(0);
    expect(v.text).toBe('0.00 USDC');
  });
});


test('display conversion leaves the exact share input used by spend paths unchanged', () => {
  const amount = '0.099891872636417805';
  const submittedBeforeDisplay = parseTokenAmount(amount, 18);
  const view = shareBalanceDisplay({ sharesExact: amount, shareSymbol: 'ppETH', rate: PP_ETH, priceMap: PRICES, fallbackPrice: 0 });
  expect(view.text).toBe('0.10 ETH');
  expect(view.hint).toBe('Worth 0.10 ETH today. The value grows as yield accrues.');
  expect(parseTokenAmount(amount, 18)).toBe(99891872636417805n);
  expect(parseTokenAmount(amount, 18)).toBe(submittedBeforeDisplay);
});

test('ppUSDT uses its own decimals, and loads before rates arrive', () => {
  const rate = { ...PP_USDC, shareSymbol: 'ppUSDT', underlyingSymbol: 'USDT' };
  const args = { sharesExact: '38.100000000000000001', shareSymbol: 'ppUSDT', priceMap: {}, fallbackPrice: 0 };
  expect(shareBalanceDisplay({ ...args, rate }).text).toBe('38.10 USDT');
  expect(shareBalanceDisplay({ ...args, rate: undefined }).text).toBe('… USDT');
  expect(parseTokenAmount(args.sharesExact, 18)).toBe(38100000000000000001n);
});

test('wallet unwrap row: a shimmer while the rate loads, then the coin figure', () => {
  // QA on #72: the row read the share count under the share's own name.
  const loading = shareBalanceDisplay({ sharesExact: '1.5', shareSymbol: 'ppUSDC', rate: undefined, priceMap: undefined, fallbackPrice: 0 });
  expect(loading.loading).toBe(true);
  expect(loading.symbol).toBe('USDC');
  const live = shareBalanceDisplay({ sharesExact: '1.5', shareSymbol: 'ppUSDC', rate: PP_USDC, priceMap: undefined, fallbackPrice: 0 });
  expect(live.loading).toBe(false);
  expect(live.symbol).toBe('USDC');
  expect(live.text).toMatch(/^[\d.,]+ USDC$/);
  // Nothing held and plain coins never shimmer.
  expect(shareBalanceDisplay({ sharesExact: '0', shareSymbol: 'ppUSDC', rate: undefined, priceMap: undefined, fallbackPrice: 0 }).loading).toBe(false);
  expect(shareBalanceDisplay({ sharesExact: '2', shareSymbol: 'USDC', rate: undefined, priceMap: undefined, fallbackPrice: 1 }).loading).toBe(false);
});
