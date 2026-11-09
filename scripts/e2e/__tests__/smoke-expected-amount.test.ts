import { describe, expect, test } from 'bun:test';
import { formatShareAsUnderlying, shareExactAsUnderlyingDecimal, type ShareRate } from '../../../services/share-rates.ts';
import { amountLines, expectedUnderlyingLabel } from '../smoke/harness.ts';

// The smoke computes the figure it expects in its own integers. This keeps that
// helper and the app's conversion saying the same thing, so a drift in either
// shows up here instead of as a confusing smoke failure.
const rate = (symbol: string, underlyingDecimals: number, assetsPerShare: bigint): ShareRate => ({
  chainId: 1, share: '0x0', underlying: '0x1', shareSymbol: `pp${symbol}`, shareDecimals: 18,
  assetsPerShare, underlyingSymbol: symbol, underlyingDecimals,
});

describe('smoke expected amount', () => {
  const cases: [string, number, boolean, bigint, bigint][] = [
    ['USDC', 6, true, 5n * 10n ** 18n, 1_090_000n],
    ['USDC', 6, true, 5n * 10n ** 18n, 1_000_000n],
    ['USDC', 6, true, 3_333_333_333_333_333_333n, 1_049_999n],
    ['ETH', 18, false, 5n * 10n ** 18n, 1_023_456_789_000_000_000n],
    ['ETH', 18, false, 5n * 10n ** 18n, 1_000_000_000_000_000_000n],
  ];
  for (const [symbol, decimals, stable, shares, assetsPerShare] of cases) {
    test(`${symbol} ${shares} shares at ${assetsPerShare}`, () => {
      const r = rate(symbol, decimals, assetsPerShare);
      const exact = shareExactAsUnderlyingDecimal(`${shares / 10n ** 18n}.${(shares % 10n ** 18n).toString().padStart(18, '0')}`, r)!;
      expect(expectedUnderlyingLabel(shares, assetsPerShare, 18, { symbol, decimals, stable })).toBe(formatShareAsUnderlying(exact, r));
    });
  }

  test('a stablecoin has two decimals, a count is not the figure', () => {
    expect(expectedUnderlyingLabel(5n * 10n ** 18n, 1_000_000n, 18, { symbol: 'USDC', decimals: 6, stable: true })).toBe('5.00 USDC');
  });

  test('amount lines are whole-line figures only', () => {
    expect(amountLines('Total\n5.00 USDC\nPay 5 USDC today\n… USDC\n1,250.50 USDC')).toEqual(['5.00 USDC', '… USDC', '1,250.50 USDC']);
  });
});
