import { describe, expect, test } from 'bun:test';

import { preferredReceiveAsset } from '@/services/receive-asset-pick';

const FDUSD = { symbol: 'FDUSD', address: '0xf' };
const PPUSDT = { symbol: 'ppUSDT', address: '0xa' };
const USDT = { symbol: 'USDT', address: '0xb' };
const BNB = { symbol: 'BNB', address: '0xe' };

describe('preferredReceiveAsset (cross-chain Send pick)', () => {
  test('keeps the coin when the narrowed list only has its share (USDT to BNB, own account)', () => {
    // Plain USDT was picked for a wallet payout; the recipient became the
    // sender, so the list is the reshield targets. The share reads as USDT.
    expect(preferredReceiveAsset([FDUSD, PPUSDT], ['USDT', 'ppUSDT'])).toBe(PPUSDT);
  });

  test('and the plain coin when the list widens back to wallet payouts', () => {
    expect(preferredReceiveAsset([BNB, FDUSD, USDT], ['ppUSDT'])).toBe(USDT);
  });

  test('falls back to the first offered asset, and to null only when nothing is offered', () => {
    expect(preferredReceiveAsset([FDUSD, PPUSDT], ['ETH'])).toBe(FDUSD);
    expect(preferredReceiveAsset([FDUSD], [null, undefined])).toBe(FDUSD);
    expect(preferredReceiveAsset([], ['USDT'])).toBeNull();
  });
});
