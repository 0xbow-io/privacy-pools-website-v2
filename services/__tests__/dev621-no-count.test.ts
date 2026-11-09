// DEV-621 (Mike, QA): a figure under a coin label is always the underlying
// value at the current vault rate; while the rate loads it is the loading
// figure (rendered as the shimmer), never the count. USD and stablecoins have
// exactly two decimals.
import { describe, expect, test } from 'bun:test';
import { shareBalanceDisplay } from '@/services/share-balance-display';
import { approxUnderlyingText, shareAmountText, shareFreeText, shareReviewHeadline, swapRateText, tokenAmountLabel } from '@/services/share-display';
import type { ShareRate } from '@/services/share-rates';
import { formatUsd } from '@/services/format-fiat';
import { detailAmountDigits, formatTokenBalance, LOADING_FIGURE, splitLoadingFigures } from '@/services/token-format';

// The QA rate: 1 share = 1.005578 USDT (18-decimal share over 6-decimal USDT).
const PP_USDT: ShareRate = {
  chainId: 1,
  share: '0x1111111111111111111111111111111111111111',
  underlying: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  shareSymbol: 'ppUSDT',
  shareDecimals: 18,
  assetsPerShare: 1_005_578n,
  underlyingSymbol: 'USDT',
  underlyingDecimals: 6,
};

describe('rule 1: never a count where the coin figure belongs', () => {
  test('every display helper loads instead of printing the count', () => {
    const texts = [
      shareBalanceDisplay({ sharesExact: '4.945', shareSymbol: 'ppUSDT', rate: undefined, priceMap: {}, fallbackPrice: 1 }).text,
      shareAmountText({ amount: 4.94, assetSymbol: 'ppUSDT', underlyingAmount: null, format: formatTokenBalance }),
      shareReviewHeadline({ isShare: true, shares: 4.94, shareSymbol: 'ppUSDT', underlyingSymbol: 'USDT', underlying: null, pending: false, format: formatTokenBalance }),
      tokenAmountLabel('4.94', 'ppUSDT'),
      approxUnderlyingText('4.94 ppUSDT', 'ppUSDT'),
      shareFreeText('Spendable now: 4.94 ppUSDT'),
    ];
    for (const text of texts) {
      expect(text).not.toMatch(/4[.,]9/);
      expect(text).not.toContain('≈');
      expect(text).not.toMatch(/ppUSDT/i);
      expect(text).toContain(`${LOADING_FIGURE} USDT`);
    }
  });

  test('with the rate the figure is the underlying value, two decimals', () => {
    const view = shareBalanceDisplay({ sharesExact: '4.945', shareSymbol: 'ppUSDT', rate: PP_USDT, priceMap: {}, fallbackPrice: 0 });
    expect(view.text).toBe('4.97 USDT');
    expect(formatUsd(view.usd)).toBe('$4.97');
  });

  test('nothing held is a real zero, not a loading figure', () => {
    expect(shareBalanceDisplay({ sharesExact: '0', shareSymbol: 'ppUSDT', rate: undefined, priceMap: {}, fallbackPrice: 1 }).text).toBe('0.00 USDT');
  });

  test('a loading figure is where the shimmer goes, an ellipsis in a sentence is not', () => {
    expect(splitLoadingFigures('… USDT')).toEqual(['', ' USDT']);
    expect(splitLoadingFigures('need … USDT, have … USDT')).toEqual(['need ', ' USDT, have ', ' USDT']);
    expect(splitLoadingFigures('Estimating USDT…')).toEqual(['Estimating USDT…']);
  });
});

describe('rule 2: two decimals for USD and stablecoins', () => {
  test('stablecoin and USD figures', () => {
    expect(formatTokenBalance(5, 'USDT')).toBe('5.00');
    expect(formatTokenBalance(4.918123, 'USDT')).toBe('4.91');
    expect(detailAmountDigits('4.918123', 'USDT')).toBe('4.91');
    expect(formatUsd(5)).toBe('$5.00');
    expect(formatUsd(4.9727)).toBe('$4.97');
  });
  test('a quote rate line is formatted by the coin, never a raw float', () => {
    expect(swapRateText(2512.123456789, { symbol: 'ETH', amount: 1 }, { symbol: 'USDT', amount: 1 })).toBe('1 ETH = 2512.12 USDT');
    expect(swapRateText(2512, { symbol: 'ETH', amount: 1 }, { symbol: 'USDT', amount: 0, loading: true })).toBe('1 ETH = … USDT');
  });
  test('ETH keeps its own precision', () => {
    expect(formatTokenBalance(0.00412, 'ETH')).toBe('0.00412');
  });
});
