import { useState } from 'react';
import { formatUnits } from 'viem';
import { useShareRates } from '@/hooks/use-share-rates';
import { useAllChainsPriceMap } from '@/hooks/use-all-chains-price-map';
import { useBalanceDisplay } from '@/hooks/use-balance-display';
import { getTokenMetadataBySymbol } from '@/config/tokens';
import { isShareSymbol, displayTokenSymbol } from '@/services/share-display';
import { shareRateSnapshotKey, shareUsdDisplayExact } from '@/services/share-balance-display';
import { parseTokenAmount, sanitizeAmountInput } from '@/services/token-amount';
import { shareAmountFromUnderlying } from '@/services/share-amount-entry';

// RULE (Pat 2026-10-21): displayed underlying never replaces exact share state.
// Headlines use underlying, with shares in the hint or while the rate is unknown.
// Only explicit Withdraw/Send edits cross the tested entry boundary, including
// USD edits using an exact decimal price snapshot. Untouched MAX stays shares.
export function useShareAmountField(args: { amount: string; symbol: string; chainId: number; maxSharesExact: string; underlyingEntry?: boolean }) {
  const { amount, symbol, chainId, maxSharesExact, underlyingEntry = true } = args;
  const { rateFor } = useShareRates();
  const prices = useAllChainsPriceMap(chainId);
  const balanceDisplay = useBalanceDisplay(chainId);
  const rate = underlyingEntry && isShareSymbol(symbol) ? rateFor(chainId, getTokenMetadataBySymbol(symbol, chainId)?.address) : undefined;
  // No stablecoin fallback: dollar ENTRY requires a real price from the grid.
  const price = rate ? prices[rate.underlying.toLowerCase()] ?? prices[rate.underlyingSymbol] ?? prices[displayTokenSymbol(rate.underlyingSymbol)] : undefined;
  const priceExact = typeof price === 'number' && Number.isFinite(price) && price > 0
    ? price.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 100 }) : undefined;
  const usdAvailable = shareUsdDisplayExact('0', rate, priceExact) !== null;
  const rateKey = shareRateSnapshotKey(rate);
  const [edit, setEdit] = useState<{ shares: string; text: string; rateKey: string; priceExact?: string; denomination: 'underlying' | 'usd'; tooSmall: boolean } | null>(null);
  const numericDisplay = (shares: string) => {
    const shown = balanceDisplay(shares || '0', symbol, chainId).text.split(' ')[0];
    // Compact or threshold labels are not valid editable numbers.
    if (/^\d+(?:\.\d+)?$/.test(shown)) return shown;
    if (!rate) return shares;
    const wei = parseTokenAmount(shares, rate.shareDecimals) * rate.assetsPerShare / 10n ** BigInt(rate.shareDecimals);
    return formatUnits(wei, rate.underlyingDecimals);
  };
  const usdDisplay = (shares: string) => shareUsdDisplayExact(shares, rate, priceExact, { field: true }) ?? '';
  const sameEdit = edit?.shares === amount && edit.rateKey === rateKey;
  return {
    value: rate && amount ? sameEdit && edit.denomination === 'underlying' ? edit.text : numericDisplay(amount) : amount,
    symbol: rate ? displayTokenSymbol(rate.underlyingSymbol) : symbol,
    usdAvailable,
    underlyingAvailable: !!rate,
    usdValue: !amount ? '' : sameEdit && edit.denomination === 'usd' && edit.priceExact === priceExact ? edit.text : usdDisplay(amount),
    error: sameEdit && edit.tooSmall ? parseTokenAmount(maxSharesExact, rate?.shareDecimals ?? 18) === 0n ? 'No shielded balance available.' : 'Amount is too small.' : null,
    presetExceedsMax(text: string): boolean | null {
      if (!rate) return null; // Raw-unit presets use the existing share guard.
      return shareAmountFromUnderlying({ text, rate, maxSharesExact,
        displayedMax: numericDisplay(maxSharesExact), preview: true }).exceedsMax;
    },
    toShares(text: string, denomination: 'underlying' | 'usd' = 'underlying') {
      if (denomination === 'usd' && !usdAvailable) return amount;
      if (!rate) return text;
      const cleaned = sanitizeAmountInput(text, denomination === 'usd' ? 18 : rate.underlyingDecimals);
      const shares = cleaned ? shareAmountFromUnderlying({ text: cleaned, rate, maxSharesExact, displayedMax: denomination === 'usd' ? usdDisplay(maxSharesExact) : numericDisplay(maxSharesExact), denomination, usdPriceExact: priceExact }) : '';
      const cap = formatUnits(parseTokenAmount(maxSharesExact, rate.shareDecimals), rate.shareDecimals);
      const clampedText = denomination === 'usd' ? usdDisplay(maxSharesExact) : numericDisplay(maxSharesExact);
      setEdit({ shares, text: shares && shares === cap ? clampedText : cleaned, rateKey, priceExact, denomination, tooSmall: /[1-9]/.test(text) && shares === '0' });
      return shares;
    },
  };
}
