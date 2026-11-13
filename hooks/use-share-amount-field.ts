import { useEffect, useState } from 'react';
import { formatUnits } from 'viem';
import { useShareRates } from '@/hooks/use-share-rates';
import { useAllChainsPriceMap } from '@/hooks/use-all-chains-price-map';
import { getTokenMetadataBySymbol } from '@/config/tokens';
import { isShareSymbol, displayTokenSymbol } from '@/services/share-display';
import { shareFieldFigure, shareRateSnapshotKey, shareUsdDisplayExact } from '@/services/share-balance-display';
import { parseTokenAmount, sanitizeAmountInput } from '@/services/token-amount';
import { shareAmountFromUnderlying } from '@/services/share-amount-entry';
import { underlyingFeedPrice } from '@/services/share-rates';

// RULE (Pat 2026-10-21): displayed underlying never replaces exact share state.
// Headlines use underlying. While the rate is unknown the field shows no figure
// (DEV-621: never a count in the coin's place); a draft typed meanwhile is
// kept and converted once the rate arrives.
// Only explicit Withdraw/Send edits cross the tested entry boundary, including
// USD edits using an exact decimal price snapshot. Untouched MAX stays shares.
export function useShareAmountField(args: { amount: string; symbol: string; chainId: number; maxSharesExact: string; capKnown: boolean; onAmountResolved: (shares: string) => void; underlyingEntry?: boolean; clampToMax?: boolean; sessionKey?: string | number }) {
  const { amount, symbol, chainId, maxSharesExact, capKnown, onAmountResolved, underlyingEntry = true, clampToMax = true, sessionKey = '' } = args;
  const { rateFor } = useShareRates();
  const prices = useAllChainsPriceMap(chainId);
  const rate = underlyingEntry && isShareSymbol(symbol) ? rateFor(chainId, getTokenMetadataBySymbol(symbol, chainId)?.address) : undefined;
  // The balance header's lookup (underlyingPriceFor) without its stablecoin
  // par fallback: dollar ENTRY requires a real price from the grid.
  const price = rate ? underlyingFeedPrice(rate, prices) : undefined;
  const priceExact = typeof price === 'number' && Number.isFinite(price) && price > 0
    ? price.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) : undefined;
  const usdAvailable = shareUsdDisplayExact('0', rate, priceExact) !== null;
  // A share field with no rate yet: the exact amount is known, its worth is not.
  const waitingRate = !rate && underlyingEntry && isShareSymbol(symbol);
  const rateKey = shareRateSnapshotKey(rate);
  // sessionKey: a form that closes and reopens (the Swap modal) starts a new
  // session, so a draft typed in the last one, still waiting on a rate, never
  // converts into the next one's amount.
  const fieldKey = `${chainId}:${symbol}:${underlyingEntry}:${sessionKey}`;
  const [edit, setEdit] = useState<{ shares: string; text: string; rateKey: string; priceExact?: string; denomination: 'underlying' | 'usd'; tooSmall: boolean; fieldKey: string; maxSharesExact: string; capKnown: boolean; pending: boolean } | null>(null);
  // Rounded DOWN from the exact converted decimal (cubic on #324), the balance
  // view's own figure (shareFieldFigure): MAX reads what the balance reads.
  const numericDisplay = (shares: string) => (rate ? shareFieldFigure(shares, rate) : shares);
  const usdDisplay = (shares: string) => shareUsdDisplayExact(shares, rate, priceExact, { field: true }) ?? '';
  const sameEdit = edit?.shares === amount && edit.rateKey === rateKey
    && edit.fieldKey === fieldKey && edit.maxSharesExact === maxSharesExact && edit.capKnown === capKnown;
  const pendingEdit = edit?.pending && edit.shares === amount && edit.fieldKey === fieldKey;
  const toShares = (text: string, denomination: 'underlying' | 'usd' = 'underlying') => {
    if (denomination === 'usd' && !usdAvailable) return amount;
    if (waitingRate) {
      // Kept as typed and converted by the effect below once the rate lands.
      setEdit({ shares: amount, text: sanitizeAmountInput(text, 18), rateKey, priceExact, denomination: 'underlying', tooSmall: false,
        fieldKey, maxSharesExact, capKnown, pending: true });
      return amount;
    }
    if (!rate) return text;
    const cleaned = sanitizeAmountInput(text, denomination === 'usd' ? 18 : rate.underlyingDecimals);
    // Unknown is not zero. Keep the draft separately, leaving exact shares
    // untouched until the existing note/spendability feed supplies the cap.
    if (!capKnown) {
      setEdit({ shares: amount, text: cleaned, rateKey, priceExact, denomination, tooSmall: false,
        fieldKey, maxSharesExact, capKnown, pending: true });
      return amount;
    }
    const shares = cleaned ? shareAmountFromUnderlying({ text: cleaned, rate, maxSharesExact, displayedMax: denomination === 'usd' ? usdDisplay(maxSharesExact) : numericDisplay(maxSharesExact), denomination, usdPriceExact: priceExact, clamp: clampToMax, rounding: clampToMax ? 'up' : 'down' }) : '';
    const cap = formatUnits(parseTokenAmount(maxSharesExact, rate.shareDecimals), rate.shareDecimals);
    const clampedText = denomination === 'usd' ? usdDisplay(maxSharesExact) : numericDisplay(maxSharesExact);
    setEdit({ shares, text: shares && shares === cap && cap !== '0' ? clampedText : cleaned, rateKey, priceExact, denomination,
      tooSmall: /[1-9]/.test(text) && shares === '0', fieldKey, maxSharesExact, capKnown, pending: false });
    return shares;
  };
  useEffect(() => {
    // Only a deferred user edit may cross the boundary here. A refreshed cap,
    // rate or price must never reparse an already resolved edit or exact MAX.
    if (!pendingEdit || !capKnown || !rate || (edit.denomination === 'usd' && !usdAvailable)) return;
    onAmountResolved(toShares(edit.text, edit.denomination));
  }, [pendingEdit, capKnown, maxSharesExact, rateKey, priceExact, edit, amount, onAmountResolved]);
  const draft = pendingEdit || sameEdit ? edit : null;
  return {
    value: draft?.denomination === 'underlying' ? draft.text : rate && amount ? numericDisplay(amount) : waitingRate ? '' : amount,
    /** The rate this field converts with is still loading: the caller shows the shimmer. */
    loading: waitingRate,
    // Always the coin, never the share's own name (2026-11-07).
    unitLabel: displayTokenSymbol(rate ? rate.underlyingSymbol : symbol),
    /** An exact share amount as the field writes it, with its coin: what MAX shows, for messages that must agree with it. */
    display: (shares: string) => (rate ? `${numericDisplay(shares)} ${displayTokenSymbol(rate.underlyingSymbol)}` : null),
    usdAvailable,
    underlyingAvailable: !!rate,
    usdValue: draft?.denomination === 'usd' && (pendingEdit || draft.priceExact === priceExact) ? draft.text : amount ? usdDisplay(amount) : '',
    error: sameEdit && edit.tooSmall ? parseTokenAmount(maxSharesExact, rate?.shareDecimals ?? 18) === 0n ? 'No shielded balance available.' : 'Amount is too small.' : null,
    presetExceedsMax(text: string): boolean | null {
      if (!rate) return null; // Raw-unit presets use the existing share guard.
      if (!capKnown) return null;
      return shareAmountFromUnderlying({ text, rate, maxSharesExact,
        displayedMax: numericDisplay(maxSharesExact), rounding: clampToMax ? 'up' : 'down', preview: true }).exceedsMax;
    },
    toShares,
  };
}
