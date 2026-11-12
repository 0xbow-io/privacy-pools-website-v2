// DEV-621 (Mike, QA on #72): one USDT yield position read "$5", "4.94 USDT",
// "5.03 USDT", "4.94 USDT $4.94" and "4.918123 USDT" on one screen. The rules:
//  1. always the underlying value, never the count; loading while the rate is out;
//  2. USD and stablecoins have exactly two decimals;
//  3. one position, one number: header, pool row, shielded balance and MAX agree;
//  4. a Transfer In row agrees with the balance it produced.
import { describe, expect, test } from 'bun:test';
import { shareBalanceDisplay, shareFieldFigure } from '@/services/share-balance-display';
import { shareAmountText, swapRateText, tokenAmountLabel, withoutShareNames } from '@/services/share-display';
import { costShareText, feeShareText, shareExactAsUnderlying, shareWeiText, type ShareRate } from '@/services/share-rates';
import { spendableBalanceLabel } from '@/services/spendable-balance-label';
import { formatUsd, formatUsdBalance } from '@/services/format-fiat';
import { detailAmountDigits, formatTokenBalance, formatTokenBalanceDown, LOADING_FIGURE, splitLoadingFigures } from '@/services/token-format';
import { claimedNetAmount } from '@/services/transfer-direction';

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
const SHARES = '4.945123456789012345';
const PRICES = { usdt: 1, USDT: 1 };

describe('rule 3: one position, one number', () => {
  test('the QA position reads 4.97 USDT and $4.97 everywhere', () => {
    const view = shareBalanceDisplay({ sharesExact: SHARES, shareSymbol: 'ppUSDT', rate: PP_USDT, priceMap: PRICES, fallbackPrice: 0 });
    // Balance header, pool row and shielded balance all print the view's text.
    expect(view.text).toBe('4.97 USDT');
    // The Withdraw MAX writes the same figure into the field.
    expect(`${shareFieldFigure(SHARES, PP_USDT)} USDT`).toBe(view.text);
    // The spendable line under the field reads the same view.
    expect(spendableBalanceLabel(SHARES, 'ppUSDT', () => view.text)).toBe(view.text);
    // The pool row converts through shareExactAsUnderlying: same cents.
    expect(formatUsd(shareExactAsUnderlying(SHARES, PP_USDT)! * 1)).toBe('$4.97');
    expect(formatUsdBalance(view.usd)).toBe('$4.97');
  });

  test('MAX equals the balance at any amount, for stablecoins and ETH alike', () => {
    const ppEth: ShareRate = { ...PP_USDT, shareSymbol: 'ppETH', underlyingSymbol: 'WETH', underlyingDecimals: 18, assetsPerShare: 1_001_094_122_102_504_299n };
    for (const shares of ['0', '0.000001', '1', '4.94', '12.999999999999999999', '1234.5678', '0.09989']) {
      for (const rate of [PP_USDT, ppEth]) {
        const view = shareBalanceDisplay({ sharesExact: shares, shareSymbol: rate.shareSymbol, rate, priceMap: PRICES, fallbackPrice: 0 });
        const field = shareFieldFigure(shares, rate);
        // A sub-cent stablecoin balance reads "<0.01"; the field holds the exact figure.
        if (view.text.startsWith('<')) continue;
        expect(`${field} ${view.symbol}`).toBe(view.text);
      }
    }
  });

  test('balances round down: a figure is never above what the holding is worth', () => {
    // 4.94 x 1.005578 = 4.96755...: 4.96, not 4.97.
    expect(shareBalanceDisplay({ sharesExact: '4.94', shareSymbol: 'ppUSDT', rate: PP_USDT, priceMap: PRICES, fallbackPrice: 0 }).text).toBe('4.96 USDT');
    expect(formatTokenBalanceDown('4.999999', 'USDT')).toBe('4.99');
  });
});

describe('rule 2: two decimals for USD and stablecoins', () => {
  test('stablecoin figures', () => {
    expect(formatTokenBalance(5, 'USDT')).toBe('5.00');
    expect(formatTokenBalance(4.918123, 'USDT')).toBe('4.91');
    expect(detailAmountDigits('4.918123', 'USDT')).toBe('4.91');
    expect(detailAmountDigits('5', 'USDC')).toBe('5.00');
  });
  test('USD figures', () => {
    expect(formatUsd(5)).toBe('$5.00');
    expect(formatUsd(4.9727)).toBe('$4.97');
    expect(formatUsdBalance(1234.5)).toBe('$1,234.50');
  });
  test('a quote rate line is formatted by the coin, never a raw float', () => {
    const eth = { symbol: 'ETH', amount: 1 };
    const usdt = { symbol: 'USDT', amount: 1 };
    expect(swapRateText(2512.123456789, eth, usdt)).toBe('1 ETH = 2512.12 USDT');
    expect(swapRateText(2512.12, eth, { ...usdt, loading: true, amount: 0 })).toBe('1 ETH = … USDT');
  });
  test('ETH keeps its own precision', () => {
    expect(formatTokenBalance(0.00412, 'ETH')).toBe('0.00412');
    expect(formatTokenBalance(1, 'ETH')).toBe('1.00');
  });
});

describe('rule 1: never a count where the coin figure belongs', () => {
  test('every display helper loads instead of printing the count', () => {
    const texts = [
      shareBalanceDisplay({ sharesExact: SHARES, shareSymbol: 'ppUSDT', rate: undefined, priceMap: PRICES, fallbackPrice: 1 }).text,
      shareAmountText({ amount: 4.94, assetSymbol: 'ppUSDT', underlyingAmount: null, format: formatTokenBalance }),
      tokenAmountLabel('4.94', 'ppUSDT'),
      withoutShareNames('Spendable now: 4.94 ppUSDT'),
      shareWeiText(4_940_000_000_000_000_000n, { symbol: 'ppUSDT', decimals: 18 }, undefined),
      feeShareText(4_940_000_000_000_000_000n, { symbol: 'ppUSDT', decimals: 18 }, undefined),
      costShareText(4_940_000_000_000_000_000n, { symbol: 'ppUSDT', decimals: 18 }, undefined),
    ];
    for (const text of texts) {
      expect(text).not.toMatch(/4[.,]9/);
      expect(text).not.toContain('≈');
      expect(text).not.toMatch(/ppUSDT/i);
      expect(text).toContain(`${LOADING_FIGURE} USDT`);
    }
  });

  test('nothing held is a real zero, not a loading figure', () => {
    expect(shareBalanceDisplay({ sharesExact: '0', shareSymbol: 'ppUSDT', rate: undefined, priceMap: PRICES, fallbackPrice: 1 }).text).toBe('0.00 USDT');
  });

  test('a loading figure is where the shimmer goes, an ellipsis in a sentence is not', () => {
    expect(splitLoadingFigures('… USDT')).toEqual(['', ' USDT']);
    expect(splitLoadingFigures('Need … USDT, have … USDT')).toEqual(['Need ', ' USDT, have ', ' USDT']);
    expect(splitLoadingFigures('Ethereum · …')).toEqual(['Ethereum · ', '']);
    expect(splitLoadingFigures(LOADING_FIGURE)).toEqual(['', '']);
    expect(splitLoadingFigures('Estimating USDT…')).toEqual(['Estimating USDT…']);
    expect(splitLoadingFigures('4.97 USDT')).toEqual(['4.97 USDT']);
  });
});

describe('rule 4: a claimed Transfer In agrees with the balance', () => {
  test('the row shows what reached the balance, the claim cost apart', () => {
    const tx = { claimTxHash: '0xabc', claimCostRaw: '60000000000000000' };
    expect(claimedNetAmount(tx, 5_000_000_000_000_000_000n)).toBe(4_940_000_000_000_000_000n);
    // Not a claim, no cost, or an unreadable cost: unchanged.
    expect(claimedNetAmount({ claimTxHash: undefined, claimCostRaw: undefined }, 5n)).toBe(5n);
    expect(claimedNetAmount({ claimTxHash: '0xabc', claimCostRaw: 'x' }, 5n)).toBe(5n);
    expect(claimedNetAmount(tx, null)).toBeNull();
  });
});
