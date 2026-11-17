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
import { useCallback } from 'react';
import { getTokenMetadataBySymbol } from '@/config/tokens';
import { useAllChainsPriceMap } from '@/hooks/use-all-chains-price-map';
import { useShareRates } from '@/hooks/use-share-rates';
import { isShareSymbol } from '@/services/share-display';
import { shareBalanceDisplay } from '@/services/share-balance-display';

/** Display only. Reads the fixed feed grid; never use its result as a spend amount. */
export function useBalanceDisplay(activeChainId?: number) {
  const { rateFor } = useShareRates();
  const prices = useAllChainsPriceMap(activeChainId);
  return useCallback((exact: string | number, symbol: string, chainId: number | undefined, address?: string) => {
    const tokenAddress = address ?? getTokenMetadataBySymbol(symbol, chainId)?.address;
    return shareBalanceDisplay({
      sharesExact: typeof exact === 'number' ? exact.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) : exact,
      shareSymbol: symbol,
      rate: isShareSymbol(symbol) && chainId != null ? rateFor(chainId, tokenAddress) : undefined,
      priceMap: prices,
      fallbackPrice: prices[symbol] ?? 0,
    });
  }, [rateFor, prices]);
}
