import { describe, expect, test } from 'bun:test';
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
