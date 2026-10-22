// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay; shares appear
// only in the (i) hint, in fields labelled with the share symbol, or while the
// rate is unknown. Never print a share count under the underlying symbol.
// Exception: Withdraw/Send edits cross shareAmountFromUnderlying once; untouched
// MAX retains the original exact shares. USD edits use an exact decimal price
// in that same boundary. No other operation converts display back.
// A share-pool balance as the headline shows it. Pure: no config imports, so it
// is unit-testable (bun cannot load config/tokens).
//
// Rate known: the UNDERLYING the shares are worth ("0.1 ETH", USD from the
// underlying's price) plus a one-line hint naming the share count. The count
// and symbol always come from the same token identity: shares use the share's
// decimals, the converted figure the underlying's (shareExactAsUnderlying).
//
// Rate unknown (loading, read gap): the share count under the SHARE's own
// symbol ("0.09989 ppETH"), never under the coin's name, so it cannot read as a
// fee ("0.09989 ETH" for a 0.1 ETH shield). Display only: nothing here feeds a
// MAX or withdraw amount, those keep reading the exact share strings.
import { formatUnits } from 'viem';
import { parseTokenAmount } from '@/services/token-amount';
import { formatTokenBalance } from '@/services/token-format';
import { displayTokenSymbol } from '@/services/share-display';
import { formatShareAsUnderlying, shareExactAsUnderlying, underlyingPriceFor, type ShareRate } from '@/services/share-rates';

export type ShareBalanceDisplay = {
  /** The figure in `symbol`, as a number. */
  amount: number;
  /** The coin the figure is in: the underlying when converted, else the share. */
  symbol: string;
  /** "0.1 ETH" or "0.09989 ppETH". */
  text: string;
  /** USD for the figure; approximate when not converted. */
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
        ? `${formatTokenBalance(shares, shareSymbol)} ${shareSymbol} shares, worth ${text} today. Shares keep their count, their value grows as yield accrues.`
        : null,
    };
  }
  // Nothing held: the coin's name reads right, and "0 ppETH" is a spelling the
  // pool page does not show. Holdings stay under the share's own symbol.
  const symbol = shares > 0 ? shareSymbol : displayTokenSymbol(shareSymbol);
  return {
    amount: shares,
    symbol,
    text: `${formatTokenBalance(shares, symbol)} ${symbol}`,
    usd: shares * fallbackPrice,
    converted: false,
    hint: null,
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
