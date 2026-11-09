// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay. The screen
// never shows the word "shares" or a share's own symbol (Pat, hard rule).
// Exception: Withdraw/Send edits cross shareAmountFromUnderlying once; untouched
// MAX retains the original exact shares. USD edits use an exact decimal price
// in that same boundary. No other operation converts display back.
// A share-pool balance as the headline shows it. Pure: no config imports, so it
// is unit-testable (bun cannot load config/tokens).
//
// Rate known: the UNDERLYING the shares are worth ("0.1 ETH", USD from the
// underlying's price) plus a one-line hint on how the value grows. The count
// and symbol always come from the same token identity: shares use the share's
// decimals, the converted figure the underlying's (shareExactAsUnderlying).
//
// Rate unknown (loading, read gap): a held share is `loading`, and a rendered
// figure shows the shimmer (components/ui/share-figure.tsx) until the rate
// arrives. `text` then holds the loading figure ("… ETH", LOADING_FIGURE),
// never the count (DEV-621). Nothing held reads as a plain zero under the coin ("0.00 ETH"). `symbol` is
// always the coin, never the share. Display only: nothing here feeds a MAX
// or withdraw amount, those keep reading the exact share strings.
import { formatUnits } from 'viem';
import { parseTokenAmount } from '@/services/token-amount';
import { formatTokenBalance, LOADING_FIGURE } from '@/services/token-format';
import { displayTokenSymbol, isShareSymbol } from '@/services/share-display';
import { formatShareAsUnderlying, shareExactAsUnderlying, underlyingPriceFor, type ShareRate } from '@/services/share-rates';

export type ShareBalanceDisplay = {
  /** The figure in `symbol`, as a number. */
  amount: number;
  /** The coin the figure is in: always the underlying's name, never the share's. */
  symbol: string;
  /**
   * "0.1 ETH", or "0.00 ETH" when nothing is held. While loading, "… ETH": a
   * rendered figure shows the shimmer there (ShareFigure, FigureText).
   */
  text: string;
  /** A share is held and its rate is not known yet: render a shimmer, not a number. */
  loading: boolean;
  /** USD for the figure; 0 while loading (the caller shows the shimmer). */
  usd: number;
  converted: boolean;
  /** Tooltip naming the share count; null when there is nothing to explain. */
  hint: string | null;
};

export function shareBalanceDisplay(args: {
  /** Exact decimal string in the SHARE's decimals (balanceTokenExact). */
  sharesExact: string;
  /** The share's own symbol as registered, e.g. "ppETH". */
  shareSymbol: string;
  rate: ShareRate | undefined;
  priceMap: Record<string, number> | undefined;
  /** Price per share-pool unit when no rate is known (0 when the feed has none). */
  fallbackPrice: number;
}): ShareBalanceDisplay {
  const { sharesExact, shareSymbol, rate, priceMap, fallbackPrice } = args;
  // The whole string must be a plain decimal: parseFloat would read "1e3" as 1000 shares.
  const shares = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(sharesExact) ? Number(sharesExact) : 0;
  const underlying = rate ? shareExactAsUnderlying(sharesExact, rate) : null;
  if (rate && underlying != null) {
    const text = formatShareAsUnderlying(underlying, rate);
    return {
      amount: underlying,
      symbol: displayTokenSymbol(rate.underlyingSymbol),
      text,
      usd: underlying * underlyingPriceFor(rate, priceMap),
      converted: true,
      hint: shares > 0
        ? `Worth ${text} today, the value grows as yield accrues.`
        : null,
      loading: false,
    };
  }
  // Nothing held reads as a plain zero; a held share waits for its rate and
  // never shows its count (DEV-621).
  const symbol = displayTokenSymbol(shareSymbol);
  const loading = isShareSymbol(shareSymbol) && shares > 0;
  return {
    amount: loading ? 0 : shares,
    symbol,
    text: `${loading ? LOADING_FIGURE : formatTokenBalance(shares, symbol)} ${symbol}`,
    usd: loading ? 0 : shares * fallbackPrice,
    converted: false,
    hint: null,
    loading,
  };
}


/** Exact USD equivalent for a field. Missing rates/prices never assume par. Display only. */
export function shareUsdDisplayExact(sharesExact: string, rate: ShareRate | undefined, priceExact: string | undefined, options?: { field?: boolean }): string | null {
  if (!rate || rate.assetsPerShare <= 0n || !priceExact || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(priceExact)) return null;
  const priceDecimals = (priceExact.split('.')[1] ?? '').length;
  const price = parseTokenAmount(priceExact, priceDecimals);
  if (price <= 0n) return null;
  const shares = parseTokenAmount(sharesExact, rate.shareDecimals);
  const assets = shares * rate.assetsPerShare / 10n ** BigInt(rate.shareDecimals);
  const usd = assets * price * 10n ** 18n / 10n ** BigInt(rate.underlyingDecimals + priceDecimals);
  if (options?.field) {
    const cents = (usd + 5_000_000_000_000_000n) / 10_000_000_000_000_000n;
    if (cents === 0n && usd > 0n) return formatUnits(usd, 18);
    return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
  }
  return formatUnits(usd, 18);
}

/** Identical refreshed rate objects must not discard the user's draft text. */
export function shareRateSnapshotKey(rate: ShareRate | undefined): string {
  return rate ? [rate.chainId, rate.share, rate.underlying, rate.shareSymbol, rate.underlyingSymbol,
    rate.shareDecimals, rate.underlyingDecimals, rate.assetsPerShare].join(':') : '';
}
