import { shareUsdDisplayExact } from '@/services/share-balance-display';
import { describe, expect, test } from 'bun:test';
import { formatUnits } from 'viem';
import { shareAmountFromUnderlying } from '@/services/share-amount-entry';
import { parseTokenAmount } from '@/services/token-amount';
import type { ShareRate } from '@/services/share-rates';

const rate = (decimals: number, assetsPerShare: bigint): ShareRate => ({ chainId: 1, share: 'share', underlying: 'asset', shareSymbol: 'ppETH', shareDecimals: 18, underlyingDecimals: decimals, underlyingSymbol: 'ETH', assetsPerShare });
const convert = (text: string, r: ShareRate, cap = '100', displayedMax = cap) => shareAmountFromUnderlying({ text, rate: r, maxSharesExact: cap, displayedMax });

describe('exact share entry boundary', () => {
  for (const decimals of [6, 8, 18]) {
    for (const extra of [0n, 1n]) {
      const r = rate(decimals, 10n ** BigInt(decimals) + extra);
      test(`${decimals} decimals, rate ${r.assetsPerShare}: round trip never exceeds shares`, () => {
        for (const shares of [1n, 999n, 99891872636417805n, 1234567890123456789n]) {
          const assets = shares * r.assetsPerShare / 10n ** 18n;
          const result = parseTokenAmount(convert(formatUnits(assets, decimals), r, '100', '999'), 18);
          expect(result).toBeLessThanOrEqual(shares);
          if (extra === 0n && decimals === 18) expect(result).toBe(shares);
        }
      });
    }
  }
  test('typed rounded MAX preserves all share wei, including asset dust', () => {
    const cap = '0.099891872636417805';
    expect(convert('0.10', rate(18, 1001100000000000000n), cap, '0.10')).toBe(cap);
    expect(convert('0.10', rate(18, 1001100000000000000n), '0.09989', '0.10')).toBe('0.09989');
    expect(convert('38.10', rate(6, 1000103n), '38.1', '38.10')).toBe('38.1');
  });
  test('clamps, rounds down, rejects invalid text and does not promote zero into dust MAX', () => {
    expect(convert('1000', rate(18, 1000000000000000001n), '0.1', '0.10')).toBe('0.1');
    expect(convert('0.1', rate(18, 1000000000000000001n), '100', '100')).toBe('0.099999999999999999');
    expect(convert('0', rate(6, 1000001n), '0.000000000000000001', '0.00')).toBe('0');
    for (const text of ['', '.', '-1', '1e3', 'NaN']) expect(convert(text, rate(18, 1n))).toBe('0');
  });
});


test('unit rates round trip exactly when shares align to 6/8-decimal asset units', () => {
  for (const decimals of [6, 8, 18]) {
    const r = rate(decimals, 10n ** BigInt(decimals));
    const grain = 10n ** BigInt(18 - decimals);
    for (const shares of [grain, 10n ** 18n, 10n ** 18n + grain]) {
      const assets = shares * r.assetsPerShare / 10n ** 18n;
      expect(parseTokenAmount(convert(formatUnits(assets, decimals), r, '100', '999'), 18)).toBe(shares);
    }
  }
});


const usdEntry = (text: string, r: ShareRate, price: string | undefined, cap = '100', displayedMax = '999') => shareAmountFromUnderlying({ text, rate: r, maxSharesExact: cap, displayedMax, denomination: 'usd', usdPriceExact: price });

describe('USD edits use the same exact share entry boundary', () => {
  for (const decimals of [6, 18]) {
    const r = rate(decimals, 10n ** BigInt(decimals));
    test(`${decimals}-decimal underlying: decimal prices never drift through floats`, () => {
      expect(usdEntry('0.30', r, '0.10')).toBe('3');
      expect(usdEntry('100000.01', r, '10000.001')).toBe('10');
      expect(usdEntry('0.01', r, '0.03')).toBe(decimals === 6 ? '0.333333' : '0.333333333333333333');
    });
    test(`${decimals}-decimal underlying: positive sub-unit dollars floor to zero`, () => {
      expect(usdEntry('0.000000000000000001', r, '2459')).toBe('0');
    });
  }
  test('USD above balance clamps and typing the displayed USD MAX keeps every share wei', () => {
    const r = rate(18, 1001094122102504299n);
    const exact = '0.099891872636417805';
    expect(usdEntry('1000', r, '2459', exact, '245.90')).toBe(exact);
    const max = usdEntry('245.90', r, '2459', exact, '245.90');
    expect(max).toBe(exact);
    expect(parseTokenAmount(max, 18)).toBe(99891872636417805n);
    expect(usdEntry('38.10', rate(6, 1000103n), '1', '38.1', '38.10')).toBe('38.1');
  });
  test('price and rate changes alter display, never the already stored or submitted shares', () => {
    const originalRate = rate(18, 10n ** 18n);
    const stored = usdEntry('200', originalRate, '2000');
    const submitted = parseTokenAmount(stored, 18);
    expect(stored).toBe('0.1');
    expect(shareUsdDisplayExact(stored, originalRate, '2000')).toBe('200');
    expect(shareUsdDisplayExact(stored, originalRate, '3000')).toBe('300');
    expect(shareUsdDisplayExact(stored, rate(18, 2n * 10n ** 18n), '3000')).toBe('600');
    expect(parseTokenAmount(stored, 18)).toBe(submitted);
    expect(submitted).toBe(100000000000000000n);
  });
  test('unknown price or rate disables dollar entry rather than guessing par', () => {
    const r = rate(6, 1000000n);
    for (const price of [undefined, '', '0', '-1', 'NaN']) {
      expect(shareUsdDisplayExact('1', r, price)).toBeNull();
      expect(usdEntry('10', r, price)).toBe('0');
    }
    expect(shareUsdDisplayExact('1', undefined, '1')).toBeNull();
  });
});
