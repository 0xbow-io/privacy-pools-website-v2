import { describe, test, expect } from 'bun:test';

import { payrollSentMatchesRow } from '@/components/payroll/io';
import { sharesForUnderlyingCeil, underlyingForSharesFloor, underlyingOfSentShares } from '@/services/underlying-amount-entry';
import type { ShareRate } from '@/services/share-rates';

// Review on #78: the shares are fixed at the rate read when the form opens, the
// paid-row check read them back at the rate at confirm time. The rate only grows
// (60 s feed), so any tick between open and confirm failed a correct payment.

function rate(assetsPerShare: bigint, over: Partial<ShareRate> = {}): ShareRate {
  return {
    chainId: 1, share: '0xshare', underlying: '0xusdt', shareSymbol: 'ppUSDT', shareDecimals: 18,
    assetsPerShare, underlyingSymbol: 'USDT', underlyingDecimals: 6, ...over,
  };
}

const RECIPIENT = '0x1111111111111111111111111111111111111111';

function check(delivered: string | null, amount: string, over: { tokenSymbol?: string; recipient?: string; chainId?: number; decimals?: number } = {}) {
  return payrollSentMatchesRow({
    details: { chainId: over.chainId ?? 1, tokenSymbol: 'ppUSDT', recipient: RECIPIENT, underlyingAmount: delivered },
    recipient: over.recipient ?? RECIPIENT,
    amount,
    tokenSymbol: over.tokenSymbol ?? 'USDT',
    decimals: over.decimals ?? 6,
    expectedChainId: 1,
  });
}

describe('payroll paid-row check across a rate tick', () => {
  test('USDT 1,018.40 at 1.005420, rate ticks to 1.005421: the old read-back fails, the fixed one passes', () => {
    const open = rate(1_005_420n);
    const tick = rate(1_005_421n);
    const shares = sharesForUnderlyingCeil('1018.40', open)!;
    // Reviewer's number: reading at the ticked rate is 1,012 base units over.
    const atTick = underlyingForSharesFloor(shares, tick)!;
    expect(check(atTick, '1018.40')).toBe(false);
    // Fixed: the sent shares equal the converted shares, so read at the open rate.
    const fixed = underlyingOfSentShares({ units: shares, liveRate: tick, converted: { shares, rate: open } });
    expect(check(fixed, '1018.40')).toBe(true);
  });

  test('18-decimal ETH rate tick passes', () => {
    const open = rate(1_130_000_000_000_000_000n, { shareDecimals: 18, underlyingDecimals: 18, shareSymbol: 'ppETH', underlyingSymbol: 'ETH' });
    const tick = rate(1_130_000_000_000_021_503n, { shareDecimals: 18, underlyingDecimals: 18, shareSymbol: 'ppETH', underlyingSymbol: 'ETH' });
    const shares = sharesForUnderlyingCeil('2.5', open)!;
    const atTick = underlyingForSharesFloor(shares, tick)!;
    const eth = { decimals: 18, tokenSymbol: 'ETH' };
    const m = (d: string | null) => payrollSentMatchesRow({
      details: { chainId: 1, tokenSymbol: 'ppETH', recipient: RECIPIENT, underlyingAmount: d },
      recipient: RECIPIENT, amount: '2.5', expectedChainId: 1, ...eth,
    });
    expect(m(atTick)).toBe(false);
    expect(m(underlyingOfSentShares({ units: shares, liveRate: tick, converted: { shares, rate: open } }))).toBe(true);
  });

  test('DEV-622 overpay still fails: the salary string used as the share count', () => {
    const open = rate(1_005_420n);
    const converted = { shares: sharesForUnderlyingCeil('1018.40', open)!, rate: open };
    const sent = underlyingOfSentShares({ units: '1018.4', liveRate: open, converted });
    expect(Number(sent)).toBeGreaterThan(1023);
    expect(check(sent, '1018.40')).toBe(false);
  });

  test('an edited amount is read at the live rate, so an overpay fails and an underpay fails', () => {
    const open = rate(1_005_420n);
    const tick = rate(1_005_421n);
    const converted = { shares: sharesForUnderlyingCeil('1018.40', open)!, rate: open };
    const more = underlyingOfSentShares({ units: '1019', liveRate: tick, converted });
    const less = underlyingOfSentShares({ units: '1000', liveRate: tick, converted });
    expect(check(more, '1018.40')).toBe(false);
    expect(check(less, '1018.40')).toBe(false);
  });

  test('without a converted record the live rate is used, null when unknown', () => {
    expect(underlyingOfSentShares({ units: '1', liveRate: null, converted: null })).toBeNull();
    expect(underlyingOfSentShares({ units: '1', liveRate: rate(1_000_000n), converted: null })).toBe('1');
  });

  test('wrong coin, recipient, chain and missing amount still fail after a tick', () => {
    const open = rate(1_005_420n);
    const shares = sharesForUnderlyingCeil('1018.40', open)!;
    const ok = underlyingOfSentShares({ units: shares, liveRate: rate(1_005_421n), converted: { shares, rate: open } });
    expect(check(ok, '1018.40')).toBe(true);
    expect(check(ok, '1018.40', { tokenSymbol: 'USDC' })).toBe(false);
    expect(check(ok, '1018.40', { recipient: '0x2222222222222222222222222222222222222222' })).toBe(false);
    expect(check(ok, '1018.40', { chainId: 10 })).toBe(false);
    expect(check(null, '1018.40')).toBe(false);
  });
});
