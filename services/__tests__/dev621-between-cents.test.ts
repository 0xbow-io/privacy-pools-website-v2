// DEV-621: a position worth between two cents must read the same lower cent on
// every surface. A USDT position of 4.779 at a price of 0.998 is worth $4.7694:
// the balance header, the pool row and the Withdraw field's dollar line after
// MAX all read "$4.76", never "$4.77".
//
// This is a unit test and not a browser smoke on purpose: the browser harness
// signs in with a fresh read-only wallet that holds no yield position, so no
// header, pool row or MAX exists on its screens. This pins the same functions
// those surfaces print through.
import { describe, expect, test } from 'bun:test';
import { shareBalanceDisplay, shareUsdDisplayExact } from '@/services/share-balance-display';
import { formatUsd, formatUsdBalance } from '@/services/format-fiat';
import { shareExactAsUnderlying, type ShareRate } from '@/services/share-rates';

// One pool unit is exactly one USDT, so 4.779 held reads 4.779 USDT.
const PAR_USDT: ShareRate = {
  chainId: 1,
  share: '0x1111111111111111111111111111111111111111',
  underlying: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  shareSymbol: 'ppUSDT',
  shareDecimals: 18,
  assetsPerShare: 1_000_000n,
  underlyingSymbol: 'USDT',
  underlyingDecimals: 6,
};
const HELD = '4.779';
const PRICE = '0.998';
const PRICES = { usdt: 0.998, USDT: 0.998 };

describe('one position between two cents, one number', () => {
  const view = shareBalanceDisplay({ sharesExact: HELD, shareSymbol: 'ppUSDT', rate: PAR_USDT, priceMap: PRICES, fallbackPrice: 0 });

  test('the balance header reads $4.76 beside 4.77 USDT, the dollar figure never rounds up to $4.77', () => {
    expect(formatUsdBalance(view.usd)).toBe('$4.76');
    expect(view.text).toBe('4.77 USDT');
  });

  test('the pool row reads the same dollar figure and the same amount', () => {
    expect(formatUsd(shareExactAsUnderlying(HELD, PAR_USDT)! * 0.998)).toBe('$4.76');
    expect(view.text).toBe(`${(Math.floor(shareExactAsUnderlying(HELD, PAR_USDT)! * 100) / 100).toFixed(2)} USDT`);
  });

  test('the Withdraw field after MAX reads $4.76 as well', () => {
    expect(shareUsdDisplayExact(HELD, PAR_USDT, PRICE, { field: true })).toBe('4.76');
  });

  test('header, pool row and field agree at every cent boundary, always rounded down', () => {
    for (const held of ['0.015', '1.999', '4.779', '9.999', '12.345', '999.995']) {
      const v = shareBalanceDisplay({ sharesExact: held, shareSymbol: 'ppUSDT', rate: PAR_USDT, priceMap: { usdt: 1, USDT: 1 }, fallbackPrice: 0 });
      const field = shareUsdDisplayExact(held, PAR_USDT, '1', { field: true });
      expect(`$${Number(field).toLocaleString('en-US', { minimumFractionDigits: 2 })}`).toBe(formatUsdBalance(v.usd));
      expect(formatUsd(shareExactAsUnderlying(held, PAR_USDT)!)).toBe(formatUsdBalance(v.usd));
      expect(field).toMatch(/^\d+\.\d{2}$/);
    }
  });
});
