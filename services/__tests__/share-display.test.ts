import { describe, expect, test } from 'bun:test';
import { approxUnderlyingText, displayTokenSymbol, isShareSymbol, shareAmountText, shareRedemptionDisclosure, shareSubtitle, wrapsIntoShareSubtitle } from '@/services/share-display';

describe('share display', () => {
  test('a share is headlined by its underlying; everything else keeps its symbol', () => {
    expect(displayTokenSymbol('ppUSDC')).toBe('USDC');
    expect(displayTokenSymbol('PPUSDT')).toBe('USDT');
    // ppETH headlines as ETH, the coin the router wraps on the way in (2026-09-18).
    expect(displayTokenSymbol('ppETH')).toBe('ETH');
    expect(isShareSymbol('ppETH')).toBe(true);
    // ppETH's underlying is WETH (the router wraps on the way in); the user
    // deposits, is priced in and receives ETH, so WETH is displayed as ETH.
    // It is NOT a share: the wrapper must not pick up share subtitles.
    expect(displayTokenSymbol('WETH')).toBe('ETH');
    expect(displayTokenSymbol('weth')).toBe('ETH');
    expect(isShareSymbol('WETH')).toBe(false);
    expect(shareSubtitle('WETH', 1.18)).toBeNull();
    expect(displayTokenSymbol('USDC')).toBe('USDC');
    expect(displayTokenSymbol('ETH')).toBe('ETH');
    expect(displayTokenSymbol('cBTC')).toBe('cBTC');
    expect(isShareSymbol('ppUSDC')).toBe(true);
    expect(isShareSymbol('USDC')).toBe(false);
    expect(isShareSymbol(undefined)).toBe(false);
  });
  test('the subtitle carries the rate and nothing else: no prose names the share', () => {
    expect(shareSubtitle('ppUSDC', 2.8834)).toBe('Earns 2.88% net APY');
    expect(shareSubtitle('ppUSDT', null)).toBe('Earns Aave yield');
    expect(shareSubtitle('ppUSDT', Number.NaN)).toBe('Earns Aave yield');
    expect(shareSubtitle('USDC', 2.88)).toBeNull();
  });
  test('an underlying that wraps on the way in reads the same line, since it is the same pool', () => {
    // The argument is the GATE (this build has a share pool for the asset),
    // not the copy. A pay row and a pool row must not read differently.
    expect(wrapsIntoShareSubtitle('ppUSDC')).toBe('Earns Aave yield');
    expect(wrapsIntoShareSubtitle('ppUSDT')).toBe('Earns Aave yield');
    expect(wrapsIntoShareSubtitle(undefined)).toBeNull();
    expect(wrapsIntoShareSubtitle('')).toBeNull();
  });
  test('a share withdrawal promises the underlying, with no fallback clause', () => {
    // The flow refuses rather than paying the share when the router route is
    // unavailable, so the line may promise the underlying outright.
    expect(shareRedemptionDisclosure('ppUSDT')).toBe(
      'You receive USDT, redeemed at the vault on the way out.',
    );
    expect(shareRedemptionDisclosure('USDT')).toBeNull();
  });
  test('Ameen via Pat, 2026-09-12: the share name appears in NO user-facing sentence', () => {
    for (const line of [
      shareSubtitle('ppUSDC', 2.88),
      shareSubtitle('ppUSDT', null),
      wrapsIntoShareSubtitle('ppUSDC'),
      shareRedemptionDisclosure('ppUSDC'),
      shareRedemptionDisclosure('ppUSDT'),
      shareSubtitle('ppETH', 1.18),
      shareRedemptionDisclosure('ppETH'),
    ]) {
      expect(line).not.toMatch(/\bpp(usdc|usdt|eth)\b/i);
    }
  });
});

describe('a share amount is shown under its underlying, converted or approximate', () => {
  const fmt = (v: number, _s: string) => v.toFixed(5);

  test('with the live rate the row prints the exact converted figure in the underlying', () => {
    // The real prod deposit: 49.913840 USDC in, 49.879113693835985131 shares
    // minted, rate 1.000696. Converted, the row must read back the USDC.
    expect(shareAmountText({ amount: 49.879113693, assetSymbol: 'ppUSDC', underlyingAmount: 49.913840, format: fmt }))
      .toBe('49.91384 USDC');
  });

  test('without the rate it prints the share COUNT under the underlying name, marked approximate', () => {
    // This is the case that shipped: the same deposit read "49.87911 ppUSDC"
    // on the public feed and looked like a fee had been taken (Pat,
    // 2026-09-12). It may never name the share, and it may never overstate.
    const text = shareAmountText({ amount: 49.879113693, assetSymbol: 'ppUSDC', underlyingAmount: null, format: fmt });
    expect(text).toBe('≈ 49.87911 USDC');
    expect(text).not.toMatch(/\bpp(usdc|usdt)\b/i);
    expect(parseFloat(text.replace('≈ ', ''))).toBeLessThan(49.913840);
  });

  test('an ordinary asset is untouched: its own number under its own symbol', () => {
    expect(shareAmountText({ amount: 1.5, assetSymbol: 'ETH', underlyingAmount: null, format: fmt })).toBe('1.50000 ETH');
    // A rate is meaningless for a non-share and must not be applied.
    expect(shareAmountText({ amount: 1.5, assetSymbol: 'ETH', underlyingAmount: 99, format: fmt })).toBe('1.50000 ETH');
  });

  test('USDT shares follow the same rule, so this is not a USDC special case', () => {
    expect(shareAmountText({ amount: 10, assetSymbol: 'ppUSDT', underlyingAmount: null, format: fmt })).toBe('≈ 10.00000 USDT');
    expect(shareAmountText({ amount: 10, assetSymbol: 'ppUSDT', underlyingAmount: 10.007, format: fmt })).toBe('10.00700 USDT');
  });

  test('a pre-formatted figure (the ASP compact string, a provider balance) is renamed in place', () => {
    expect(approxUnderlyingText('1.23K ppUSDC', 'ppUSDC')).toBe('≈ 1.23K USDC');
    expect(approxUnderlyingText('0.0000 ppUSDT', 'ppUSDT')).toBe('≈ 0.0000 USDT');
    // Case as the ASP sends it.
    expect(approxUnderlyingText('5 PPUSDC', 'ppUSDC')).toBe('≈ 5 USDC');
    // Idempotent: a string already marked is not marked twice.
    expect(approxUnderlyingText('≈ 1.23K USDC', 'ppUSDC')).toBe('≈ 1.23K USDC');
    // Non-shares and empties pass straight through.
    expect(approxUnderlyingText('1.5 ETH', 'ETH')).toBe('1.5 ETH');
    expect(approxUnderlyingText('', 'ppUSDC')).toBe('');
  });
});

import { netSharesWei, shareReviewHeadline } from '@/services/share-display';

describe('share review figures', () => {
  test('net shares are bigint arithmetic, never a re-parsed float', () => {
    expect(netSharesWei(300000000000000000n, 100000000000000000n, false)).toBe(200000000000000000n);
    expect(netSharesWei(300000000000000000n, 100000000000000000n, true)).toBe(300000000000000000n);
    expect(netSharesWei(100n, 100n, false)).toBeNull();
    expect(netSharesWei(0n, 0n, true)).toBeNull();
  });
  test('a share reads as USDC converted, estimating, or approximate - never as the share', () => {
    const format = (n: number) => String(n);
    const base = { isShare: true, shares: 100, shareSymbol: 'ppUSDC', underlyingSymbol: 'USDC', format };
    expect(shareReviewHeadline({ ...base, underlying: 105.2, pending: false })).toBe('≈ 105.2 USDC');
    expect(shareReviewHeadline({ ...base, underlying: null, pending: true })).toBe('Estimating USDC…');
    // The read failed, not in flight: still the underlying's name, marked
    // approximate and understating (Pat, 2026-09-12).
    expect(shareReviewHeadline({ ...base, underlying: null, pending: false })).toBe('≈ 100 USDC');
    expect(shareReviewHeadline({ ...base, underlying: null, pending: false })).not.toMatch(/\bpp(usdc|usdt)\b/i);
    expect(shareReviewHeadline({ ...base, isShare: false, shareSymbol: 'ETH', underlyingSymbol: 'ETH', underlying: null, pending: false })).toBe('100 ETH');
  });
});
