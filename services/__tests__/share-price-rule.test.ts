import { expect, test } from 'bun:test';
import { applySharePriceFallback, sharePriceKeys } from '@/services/share-price-rule';
const tokens = [
  { symbol: 'ETH', address: '0xnative', isNative: true },
  { symbol: 'ppETH', address: '0xShare', isNative: false, yieldShare: true },
  { symbol: 'ppUSDC', address: '0xStable', isNative: false, yieldShare: true },
];
const keys = sharePriceKeys(tokens, [
  { ppUSDC: '0xshare', underlyingSymbol: 'WETH', nativeMode: true },
  { ppUSDC: '0xstable', underlyingSymbol: 'USDC' },
]);
test('native-mode WETH prices with the chain coin; ERC-20s keep their underlying', () => {
  const prices: Record<string, number> = { ETH: 2000, USDC: 1 };
  applySharePriceFallback(prices, keys);
  expect(prices.ppETH).toBe(2000);
  expect(prices['0xshare']).toBe(2000);
  expect(prices.ppUSDC).toBe(1);
  expect(sharePriceKeys(tokens, [])).toEqual([]);
});
test('share feed price wins by address or symbol, while zero permits fallback', () => {
  for (const key of ['0xshare', 'ppETH', 'ppeth']) {
    const prices = { ETH: 2000, [key]: 2100 };
    applySharePriceFallback(prices, keys);
    expect(prices['0xshare']).toBe(2100);
    expect(prices.ppETH).toBe(2100);
  }
  const prices: Record<string, number> = { ETH: 2000, ppETH: 0 };
  applySharePriceFallback(prices, keys);
  expect(prices.ppETH).toBe(2000);
});
