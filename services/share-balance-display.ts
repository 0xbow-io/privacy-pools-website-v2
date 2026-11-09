// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay. The screen
// never shows the pool unit's noun, its own symbol, or a count where the
// coin's figure belongs.
// Exception: Withdraw/Send edits cross shareAmountFromUnderlying once; untouched
// MAX retains the original exact shares. USD edits use an exact decimal price
// in that same boundary. No other operation converts display back.
// A share-pool balance as the headline shows it. Pure: no config imports, so it
// is unit-testable (bun cannot load config/tokens).
//
// Rate known: the UNDERLYING the holding is worth ("0.1 ETH", USD from the
// underlying's price) plus a one-line hint on how the value grows. Converted
// in integers from the exact string and rounded DOWN (formatTokenBalanceDown),
// the same conversion and rounding as the Withdraw MAX, so the balance header,
// the pool row, the shielded balance and MAX print one number (DEV-621).
//
// Rate unknown (loading, read gap): a holding is `loading` and its `text` is
// the loading figure ("… ETH", LOADING_FIGURE). A rendered figure shows the
// shimmer (components/ui/share-figure.tsx) until the rate arrives; a count
// never stands in for it (DEV-621). Nothing held reads as a plain zero under
// the coin ("0.00 ETH"). `symbol` is always the coin, never the share. Display
// only: nothing here feeds a MAX or withdraw amount, those keep reading the
// exact share strings.
import { formatUnits } from 'viem';
import { parseTokenAmount } from '@/services/token-amount';
import { formatTokenBalanceDown, LOADING_FIGURE } from '@/services/token-format';
import { displayTokenSymbol, isShareSymbol } from '@/services/share-display';
import { displayUnderlyingWei, formatShareAsUnderlying, shareExactAsUnderlyingDecimal, underlyingPriceFor, type ShareRate } from '@/services/share-rates';

export type ShareBalanceDisplay = {
  /** The figure in `symbol`, as a number. */
  amount: number;
  /** The coin name shown: always the underlying (the share is never named). */
  symbol: string;
  /** "0.1 ETH", "0.00 ETH" when nothing is held, "… ETH" while loading. */
  text: string;
  /** A share is held and its rate is not known yet: render a shimmer, not a number. */
  loading: boolean;
  /** USD for the figure; 0 while loading (the caller shows the shimmer). */
  usd: number;
  converted: boolean;
  /** Tooltip naming what the balance is worth today; null when there is nothing to explain. */
  hint: string | null;
};

export function shareBalanceDisplay(args: {
  /** Exact decimal string in the SHARE's decimals (balanceTokenExact). */
  sharesExact: string;
  /** The share's own symbol as registered, e.g. "ppETH". */
  shareSymbol: string;
  rate: ShareRate | undefined;
  priceMap: Record<string, number> | undefined;
  /** Price per pool unit of a token that is not a share (0 when the feed has none). */
  fallbackPrice: number;
}): ShareBalanceDisplay {
  const { sharesExact, shareSymbol, rate, priceMap, fallbackPrice } = args;
  // The whole string must be a plain decimal: parseFloat would read "1e3" as 1000 shares.
  const plain = /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(sharesExact);
  const shares = plain ? Number(sharesExact) : 0;
  const underlyingExact = rate ? shareExactAsUnderlyingDecimal(sharesExact, rate) : null;
  if (rate && underlyingExact != null) {
    const underlying = Number(underlyingExact);
    const text = formatShareAsUnderlying(underlyingExact, rate);
    return {
      amount: underlying,
      symbol: displayTokenSymbol(rate.underlyingSymbol),
      text,
      usd: underlying * underlyingPriceFor(rate, priceMap),
      converted: true,
      hint: shares > 0
        ? `Worth ${text} today. The value grows as yield accrues.`
        : null,
      loading: false,
    };
  }
  const symbol = displayTokenSymbol(shareSymbol);
  const loading = isShareSymbol(shareSymbol) && shares > 0;
  // Nothing held reads as a plain zero; a held share waits for its rate.
  return {
    amount: loading ? 0 : shares,
    symbol,
    text: `${loading ? LOADING_FIGURE : formatTokenBalanceDown(plain ? sharesExact : '0', symbol)} ${symbol}`,
    usd: loading ? 0 : shares * fallbackPrice,
    converted: false,
    hint: null,
    loading,
  };
}


/**
 * An exact share amount as an editable figure in the underlying: the Withdraw
 * and Send field and their MAX. The same conversion and rounding (DOWN) as
 * shareBalanceDisplay, so MAX reads the number the balance header, the pool
 * row and the shielded balance read (DEV-621). A threshold label ("<0.01") is
 * not a number a field can hold, so that case keeps the exact decimal.
 */
export function shareFieldFigure(sharesExact: string, rate: ShareRate): string {
  const exact = formatUnits(displayUnderlyingWei(parseTokenAmount(sharesExact || '0', rate.shareDecimals), rate), rate.underlyingDecimals);
  const shown = formatTokenBalanceDown(exact, displayTokenSymbol(rate.underlyingSymbol));
  return /^\d+(?:\.\d+)?$/.test(shown) ? shown : exact;
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
