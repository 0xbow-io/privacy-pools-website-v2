import { formatUnits } from 'viem';
import { parseTokenAmount } from '@/services/token-amount';
import type { ShareRate } from '@/services/share-rates';

/** The ONLY underlying-entry boundary. Everything returned is exact shares.
 * Untouched MAX bypasses this function and retains its original share string.
 * A typed displayed MAX means the full exact cap, including sub-asset dust.
 */
type ShareEntryArgs = {
  text: string;
  rate: ShareRate;
  maxSharesExact: string;
  displayedMax: string;
  denomination?: 'underlying' | 'usd';
  usdPriceExact?: string;
};

type ShareEntryPreview = { shares: string; exceedsMax: boolean };

export function shareAmountFromUnderlying(args: ShareEntryArgs & { preview: true }): ShareEntryPreview;
export function shareAmountFromUnderlying(args: ShareEntryArgs & { preview?: false }): string;
export function shareAmountFromUnderlying(args: ShareEntryArgs & { preview?: boolean }): string | ShareEntryPreview {
  // Preset eligibility reads the same exact entry calculation without editing
  // state. Report whether it exceeded the cap BEFORE clamping; the amount
  // returned for actual entry is unchanged and always stays within the cap.
  const result = (shares: string, exceedsMax = false): string | ShareEntryPreview =>
    args.preview ? { shares, exceedsMax } : shares;
  const { text, rate, maxSharesExact, displayedMax } = args;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(text) || rate.assetsPerShare <= 0n) return result('0');
  let assets: bigint;
  let isDisplayedMax: boolean;
  if (args.denomination === 'usd') {
    // Decimal rational arithmetic. No floating point touches the entered USD,
    // the price snapshot, the underlying base units, or the resulting shares.
    const price = args.usdPriceExact;
    if (!price || !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(price)) return result('0');
    const usdDecimals = (text.split('.')[1] ?? '').length;
    const priceDecimals = (price.split('.')[1] ?? '').length;
    const usd = parseTokenAmount(text, usdDecimals);
    const priceUnits = parseTokenAmount(price, priceDecimals);
    if (priceUnits <= 0n) return result('0');
    assets = usd * 10n ** BigInt(priceDecimals + rate.underlyingDecimals)
      / (10n ** BigInt(usdDecimals) * priceUnits);
    const maxDecimals = (displayedMax.split('.')[1] ?? '').length;
    isDisplayedMax = usd * 10n ** BigInt(maxDecimals)
      === parseTokenAmount(displayedMax, maxDecimals) * 10n ** BigInt(usdDecimals);
  } else {
    assets = parseTokenAmount(text, rate.underlyingDecimals);
    isDisplayedMax = assets === parseTokenAmount(displayedMax, rate.underlyingDecimals);
  }
  const cap = parseTokenAmount(maxSharesExact, rate.shareDecimals);
  if (assets === 0n) return result('0');
  if (isDisplayedMax) return result(formatUnits(cap, rate.shareDecimals));
  const shares = assets * 10n ** BigInt(rate.shareDecimals) / rate.assetsPerShare;
  return result(formatUnits(shares > cap ? cap : shares, rate.shareDecimals), shares > cap);
}
