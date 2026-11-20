import { describe, expect, test } from 'bun:test';
import { formatUnits } from 'viem';
import { shareBalanceDisplay } from '@/services/share-balance-display';
import type { ShareRate } from '@/services/share-rates';
import { costFigureText, costView, formatTokenBalanceDown } from '@/services/token-format';

// DEV-822: Review showed a 1000.00 USDT swap with a "0.48" relayer fee and a
// "999.51" net. The real fee was 0.485: both figures were cut DOWN, so the
// lines summed to 999.99. A cost rounds up, the net down, and they add back.
describe('costFigureText', () => {
  test('rounds a stablecoin cost up to the cent, no separator', () => {
    expect(costFigureText(0.485, 'USDT')).toBe('0.49 USDT');
    expect(costFigureText(0.48, 'USDT')).toBe('0.48 USDT');
    expect(costFigureText(0.001, 'USDC')).toBe('0.01 USDC');
    expect(costFigureText(1234.561, 'USDC')).toBe('1234.57 USDC');
    expect(costFigureText(0, 'USDC')).toBe('0.00 USDC');
  });

  test('leaves other assets to their own formatting', () => {
    expect(costFigureText(0.000123, 'ETH')).toBeNull();
    expect(costFigureText(NaN, 'USDC')).toBeNull();
  });

  test('cost rounded up plus net rounded down equals the gross to the cent', () => {
    const grossCents = 100000; // 1000.00
    for (const feeMicro of [485000, 480000, 481234, 489999, 1, 999999]) {
      const fee = feeMicro / 1e6;
      const net = 1000 - fee;
      const feeCents = Math.round(Number(costFigureText(fee, 'USDT')!.split(' ')[0]) * 100);
      const netCents = Math.round(Number(formatTokenBalanceDown(net, 'USDT').split(' ')[0]) * 100);
      expect(feeCents + netCents).toBe(grossCents);
    }
  });
});

describe('costView', () => {
  const view = { amount: 0.485, symbol: 'USDC', text: '0.48 USDC', loading: false, hint: 'Worth 0.48 USDC today. The value grows as yield accrues.' };
  test('rounds the figure up and keeps the hint naming the same figure', () => {
    const out = costView(view);
    expect(out.text).toBe('0.49 USDC');
    expect(out.hint).toBe('Worth 0.49 USDC today. The value grows as yield accrues.');
  });
  test('leaves a loading view, a missing hint and other assets alone', () => {
    expect(costView({ ...view, loading: true })).toEqual({ ...view, loading: true });
    expect(costView({ ...view, hint: null }).hint).toBeNull();
    const eth = { amount: 0.000123, symbol: 'ETH', text: '0.000123 ETH', loading: false, hint: null };
    expect(costView(eth)).toBe(eth);
  });
});

const balance = (exact: string, symbol = 'USDC', rate?: ShareRate) => shareBalanceDisplay({
  sharesExact: exact, shareSymbol: symbol, rate, priceMap: undefined, fallbackPrice: 1,
});
const cents = (text: string) => BigInt(text.split(' ')[0].replace('.', ''));

describe('review fee reconciliation', () => {
  test('fixes both the original shortfall and fractional-cent excess', () => {
    const fee = balance('0.485');
    expect(costView(fee, { gross: balance('1000'), net: balance('999.515') }).text).toBe('0.49 USDC');
    expect(costView(fee, { gross: balance('1000.005'), net: balance('999.52') }).text).toBe('0.48 USDC');
    expect(fee.text).toBe('0.48 USDC'); // input is not mutated
  });

  test('gross equals displayed fee plus net across all sub-cent gross offsets', () => {
    for (let offset = 0n; offset < 10000n; offset += 1n) {
      const grossWei = 1000_000000n + offset;
      for (const feeWei of [0n, 1n, 480000n, 485000n, 489999n]) {
        const gross = balance(formatUnits(grossWei, 6));
        const net = balance(formatUnits(grossWei - feeWei, 6));
        const fee = balance(formatUnits(feeWei, 6));
        const shown = costView(fee, { gross, net });
        expect(cents(shown.text) + cents(net.text)).toBe(cents(gross.text));
        expect(shown.amount).toBe(fee.amount);
        expect(shown.usd).toBe(fee.usd);
      }
    }
  });

  test('converted share fees reconcile in underlying cents and update the hint', () => {
    const rate: ShareRate = {
      chainId: 1, share: '0x0000000000000000000000000000000000000001',
      underlying: '0x0000000000000000000000000000000000000002',
      shareSymbol: 'ppUSDC', underlyingSymbol: 'USDC', shareDecimals: 18,
      underlyingDecimals: 6, assetsPerShare: 1_005_000n,
    };
    const fee = balance('0.485', 'ppUSDC', rate);
    const gross = balance('1000.005', 'ppUSDC', rate);
    const net = balance('999.520', 'ppUSDC', rate);
    const shown = costView(fee, { gross, net });
    expect(cents(shown.text) + cents(net.text)).toBe(cents(gross.text));
    expect(shown.hint).toBe(`Worth ${shown.text} today. The value grows as yield accrues.`);
    expect(shown.amount).toBe(fee.amount);
    expect(shown.converted).toBe(true);
  });

  test('does not force reconciliation across loading, thresholds, currencies or other deductions', () => {
    const fee = balance('0.485');
    const unchanged = costView(fee);
    for (const net of [balance('999'), balance('1001'), balance('999.52', 'USDT'), balance('0.001'), { ...balance('999.52'), loading: true }]) {
      expect(costView(fee, { gross: balance('1000.005'), net })).toEqual(unchanged);
    }
    const loading = balance('1', 'ppUSDC');
    expect(costView(loading, { gross: balance('1000'), net: balance('999') })).toBe(loading);
    const eth = balance('0.485', 'ETH');
    expect(costView(eth, { gross: balance('1000', 'ETH'), net: balance('999.515', 'ETH') })).toBe(eth);
  });
});
