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
