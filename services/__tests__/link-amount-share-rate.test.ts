// A pay or claim link carries an exact SHARE count for a yield pool token. The
// page must show the underlying that count is worth at the page's own rate,
// 2 decimals rounded down for a stablecoin, and a loading figure (never the
// share count under the coin's name) while the rate is unknown. Display only:
// the link and the amount paid stay in shares.
import { describe, expect, test } from 'bun:test';
import { parseUnits } from 'viem';
import { linkAmountText, type LinkToken } from '@/services/link-token';
import { LOADING_FIGURE } from '@/services/token-format';
import type { ShareRate } from '@/services/share-rates';

const rate = (assetsPerShare: bigint, over: Partial<ShareRate> = {}): ShareRate => ({
  chainId: 1,
  share: '0xc246afb23482ff9596e9cee5f1f678efe0eb1ad6',
  underlying: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  shareSymbol: 'ppUSDC',
  shareDecimals: 18,
  assetsPerShare,
  underlyingSymbol: 'USDC',
  underlyingDecimals: 6,
  ...over,
});
const PP_USDC: LinkToken = { known: true, symbol: 'ppUSDC', decimals: 18 };
const PP_ETH: LinkToken = { known: true, symbol: 'ppETH', decimals: 18 };

describe('link amount for a share token', () => {
  test('1.05 rate: 100 shares are shown as 105.00 USDC, not 100', () => {
    expect(linkAmountText(parseUnits('100', 18), PP_USDC, rate(1_050_000n))).toBe('105.00 USDC');
    expect(linkAmountText(parseUnits('5', 18), PP_USDC, rate(1_050_000n))).toBe('5.25 USDC');
  });

  test('the requester types underlying U, the link holds U / rate shares, the page shows U back', () => {
    const r = rate(1_050_000n);
    const typedUnderlying = 105n * 10n ** 6n;
    const shares = (typedUnderlying * 10n ** 18n) / r.assetsPerShare;
    expect(linkAmountText(shares, PP_USDC, r)).toBe('105.00 USDC');
  });

  test('stablecoin figures round down to 2 decimals', () => {
    // 1 share worth 1.019999 USDC reads 1.01, never 1.02.
    expect(linkAmountText(parseUnits('1', 18), PP_USDC, rate(1_019_999n))).toBe('1.01 USDC');
  });

  test('ETH shows 5 decimals, and WETH reads as ETH', () => {
    const eth = rate(1_001_094_122_102_504_299n, { share: '0x66051920d25af4e3596a8a46309f4d045f9d83b7', shareSymbol: 'ppETH', underlyingSymbol: 'WETH', underlyingDecimals: 18 });
    expect(linkAmountText(parseUnits('0.09989', 18), PP_ETH, eth)).toBe('0.09999 ETH');
  });

  test('rate unavailable: a loading figure, never the share count under the coin name', () => {
    const text = linkAmountText(parseUnits('100', 18), PP_USDC);
    expect(text).toBe(`${LOADING_FIGURE} USDC`);
    expect(text).not.toContain('100');
  });

  test('a rate of another decimals layout is not applied', () => {
    expect(linkAmountText(parseUnits('100', 18), PP_USDC, rate(1_050_000n, { shareDecimals: 6 }))).toBe(`${LOADING_FIGURE} USDC`);
  });

  test('a plain token is unaffected by a rate', () => {
    const usdc: LinkToken = { known: true, symbol: 'USDC', decimals: 6 };
    expect(linkAmountText(3_000_000n, usdc, rate(1_050_000n))).toBe('3.00 USDC');
  });
});
