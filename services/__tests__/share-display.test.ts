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

describe('a share amount uses underlying only after conversion', () => {
  const fmt = (v: number, _s: string) => v.toFixed(5);

  test('with the live rate the row prints the exact converted figure in the underlying', () => {
    // The real prod deposit: 49.913840 USDC in, 49.879113693835985131 shares
    // minted, rate 1.000696. Converted, the row must read back the USDC.
    expect(shareAmountText({ amount: 49.879113693, assetSymbol: 'ppUSDC', underlyingAmount: 49.913840, format: fmt }))
      .toBe('49.91384 USDC');
  });

  test('without the rate it keeps the share COUNT under its own symbol', () => {
    // Without a rate the figure is still a share count, not USDC.
    const text = shareAmountText({ amount: 49.879113693, assetSymbol: 'ppUSDC', underlyingAmount: null, format: fmt });
    expect(text).toBe('49.87911 ppUSDC');
    expect(text).toContain('ppUSDC');
    expect(parseFloat(text.replace('≈ ', ''))).toBeLessThan(49.913840);
  });

  test('an ordinary asset is untouched: its own number under its own symbol', () => {
    expect(shareAmountText({ amount: 1.5, assetSymbol: 'ETH', underlyingAmount: null, format: fmt })).toBe('1.50000 ETH');
    // A rate is meaningless for a non-share and must not be applied.
    expect(shareAmountText({ amount: 1.5, assetSymbol: 'ETH', underlyingAmount: 99, format: fmt })).toBe('1.50000 ETH');
  });

  test('USDT shares follow the same rule, so this is not a USDC special case', () => {
    expect(shareAmountText({ amount: 10, assetSymbol: 'ppUSDT', underlyingAmount: null, format: fmt })).toBe('10.00000 ppUSDT');
    expect(shareAmountText({ amount: 10, assetSymbol: 'ppUSDT', underlyingAmount: 10.007, format: fmt })).toBe('10.00700 USDT');
  });

  test('a pre-formatted share fallback keeps its own units', () => {
    expect(approxUnderlyingText('1.23K ppUSDC', 'ppUSDC')).toBe('1.23K ppUSDC');
    expect(approxUnderlyingText('0.0000 ppUSDT', 'ppUSDT')).toBe('0.0000 ppUSDT');
    // Case as the ASP sends it.
    expect(approxUnderlyingText('5 PPUSDC', 'ppUSDC')).toBe('5 PPUSDC');
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
  test('a share reads as converted USDC, estimating, or the share fallback', () => {
    const format = (n: number) => String(n);
    const base = { isShare: true, shares: 100, shareSymbol: 'ppUSDC', underlyingSymbol: 'USDC', format };
    expect(shareReviewHeadline({ ...base, underlying: 105.2, pending: false })).toBe('≈ 105.2 USDC');
    expect(shareReviewHeadline({ ...base, underlying: null, pending: true })).toBe('Estimating USDC…');
    // The read failed: the fallback is a share count, so it names the share.
    expect(shareReviewHeadline({ ...base, underlying: null, pending: false })).toBe('100 ppUSDC');
    expect(shareReviewHeadline({ ...base, underlying: null, pending: false })).toContain('ppUSDC');
    expect(shareReviewHeadline({ ...base, isShare: false, shareSymbol: 'ETH', underlyingSymbol: 'ETH', underlying: null, pending: false })).toBe('100 ETH');
  });
});
