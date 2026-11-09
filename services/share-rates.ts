// A yield share shown as the underlying it is worth. ppUSDC is USDC held in
// the Aave vault; every share is worth `convertToAssets(1 share)` USDC, a
// figure that only grows. Rows print that value ("38.10 USDC") instead of the
// share count labelled ppUSDC (Pat + Ameen, 2026-09-05: no "held as" label or
// tooltip anywhere; the share is only named in the row's own subtitle-free
// symbol cell as USDC).
//
// Pure conversion here (unit-testable: no config imports); the deployment list
// and the live rate come from hooks/use-share-rates.ts.
import { formatUnits, parseUnits, type Address } from 'viem';
import { formatTokenBalanceDown, isStablecoin, LOADING_FIGURE } from '@/services/token-format';
import { formatShortfallAmount } from '@/services/relayed-payment-shortfall';
import { displayTokenSymbol, isShareSymbol, tokenAmountLabel, type ShareRateOf } from '@/services/share-display';

export const SHARE_CONVERT_ABI = [
  {
    type: 'function',
    name: 'convertToAssets',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: 'assets', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

export type ShareRate = {
  chainId: number;
  /** The share token (ppUSDC) address, lower-cased. */
  share: string;
  /** The underlying token (USDC) address, lower-cased: the price-map key. */
  underlying: string;
  shareSymbol: string;
  shareDecimals: number;
  /** Underlying units one whole share (10^shareDecimals) is worth right now. */
  assetsPerShare: bigint;
  underlyingSymbol: string;
  underlyingDecimals: number;
};

export type ShareDeploymentRef = Pick<ShareRate, 'chainId' | 'share' | 'underlying' | 'shareSymbol' | 'shareDecimals' | 'underlyingSymbol' | 'underlyingDecimals'>;


export function shareRateKey(chainId: number, share: string): string {
  return `${chainId}:${share.toLowerCase()}`;
}

/** convertToAssets(one whole share) on the vault. */
export async function fetchAssetsPerShare(
  client: { readContract: (args: { address: Address; abi: typeof SHARE_CONVERT_ABI; functionName: 'convertToAssets'; args: readonly [bigint] }) => Promise<unknown> },
  ref: ShareDeploymentRef,
): Promise<bigint> {
  const assets = await client.readContract({
    address: ref.share as Address,
    abi: SHARE_CONVERT_ABI,
    functionName: 'convertToAssets',
    args: [10n ** BigInt(ref.shareDecimals)],
  });
  return assets as bigint;
}

/**
 * Underlying value of a share amount given as an exact decimal string (the
 * balance rows carry full-precision strings), computed in integers.
 */
export function shareExactAsUnderlying(sharesExact: string, rate: ShareRate): number | null {
  const exact = shareExactAsUnderlyingDecimal(sharesExact, rate);
  return exact == null ? null : Number(exact);
}

/**
 * shareExactAsUnderlying as the exact decimal string of the underlying's base
 * units: the input formatTokenBalanceDown needs to round a balance DOWN the
 * same way the Withdraw MAX does (hooks/use-share-amount-field.ts).
 */
export function shareExactAsUnderlyingDecimal(sharesExact: string, rate: ShareRate): string | null {
  let sharesWei: bigint;
  try {
    sharesWei = parseUnits(sharesExact || '0', rate.shareDecimals);
  } catch {
    // Not a decimal string this rate can convert: the caller shows the figure
    // as loading rather than printing a false "0.00 USDC" (codex on 0659770).
    return null;
  }
  return formatUnits(displayUnderlyingWei(sharesWei, rate), rate.underlyingDecimals);
}

/**
 * The underlying base units a share amount is worth, for DISPLAY: the exact
 * product taken up to the next base unit. A typed underlying amount is turned
 * into the pool's units by flooring (shareAmountFromUnderlying), which leaves
 * it worth a fraction of a base unit less than typed; a floor here as well made a typed
 * "5" read back "4.99" once rounded down to cents. Never an operation amount.
 */
export function displayUnderlyingWei(sharesWei: bigint, rate: ShareRate): bigint {
  const unit = 10n ** BigInt(rate.shareDecimals);
  const product = sharesWei * rate.assetsPerShare;
  return product / unit + (product % unit > 0n ? 1n : 0n);
}

/**
 * USD price of the underlying, from the pools price map (keyed by lower-cased
 * address, then symbol); a stablecoin with no quote is $1. The dollar figure
 * beside a converted amount must use the SAME converted quantity × this price,
 * never shares × price (codex on 0659770).
 */
export function underlyingPriceFor(rate: ShareRate, priceMap: Record<string, number> | undefined): number {
  return underlyingFeedPrice(rate, priceMap) ?? (isStablecoin(rate.underlyingSymbol) ? 1 : 0);
}

/**
 * The feed's own quote for the underlying, the lookup underlyingPriceFor makes
 * before its stablecoin par fallback: undefined when the feed has none. The
 * amount field prices its dollar line with this, so it reads the same number
 * as the balance header (DEV-621) and never assumes par for dollar entry.
 */
export function underlyingFeedPrice(rate: ShareRate, priceMap: Record<string, number> | undefined): number | undefined {
  const byAddress = priceMap?.[rate.underlying.toLowerCase()];
  if (typeof byAddress === 'number' && byAddress > 0) return byAddress;
  const bySymbol = priceMap?.[rate.underlyingSymbol] ?? priceMap?.[rate.underlyingSymbol.toLowerCase()];
  if (typeof bySymbol === 'number' && bySymbol > 0) return bySymbol;
  // A wrapped underlying (WETH) is priced as the coin it wraps (ETH) when the
  // feed only carries the native symbol.
  const shown = displayTokenSymbol(rate.underlyingSymbol);
  const byDisplay = shown === rate.underlyingSymbol ? undefined : (priceMap?.[shown] ?? priceMap?.[shown.toLowerCase()]);
  if (typeof byDisplay === 'number' && byDisplay > 0) return byDisplay;
  return undefined;
}

/** Underlying value of a share amount already held as a number (the activity rows). */
export function shareNumberAsUnderlying(shares: number, rate: ShareRate): number {
  if (!Number.isFinite(shares)) return 0;
  return shares * Number(formatUnits(rate.assetsPerShare, rate.underlyingDecimals));
}

/**
 * "38.10 USDC" for a share balance, at the live rate. Rounded DOWN like every
 * balance and MAX (DEV-621); pass the exact decimal string when there is one.
 */
export function formatShareAsUnderlying(value: number | string, rate: ShareRate): string {
  const symbol = displayTokenSymbol(rate.underlyingSymbol);
  return `${formatTokenBalanceDown(value, symbol)} ${symbol}`;
}


/**
 * Rate lookup by share symbol for free text (withoutShareNames), which names a
 * share but not its chain. With `chainId` only that chain's share counts. Without
 * one a symbol converts only when EVERY configured deployment of it
 * (`configured`, the feed's own list) has a rate and they agree to one part in
 * a million. A deployment whose read failed is missing from `rates`, and the
 * rates that are present say nothing about it, so the text then keeps the
 * approximate share count rather than pick a chain it cannot see.
 */
export function shareRateOf(
  rates: readonly ShareRate[],
  chainId?: number,
  configured: readonly Pick<ShareRate, 'chainId' | 'share' | 'shareSymbol'>[] = [],
): ShareRateOf {
  return (shareSymbol) => {
    const upper = shareSymbol.toUpperCase();
    const matching = rates.filter((r) => r.shareSymbol.toUpperCase() === upper && (chainId === undefined || r.chainId === chainId));
    if (chainId === undefined) {
      const expected = configured.filter((d) => d.shareSymbol.toUpperCase() === upper);
      const covered = expected.every((d) => matching.some((r) => r.chainId === d.chainId && r.share.toLowerCase() === d.share.toLowerCase()));
      if (expected.length === 0 || !covered) return undefined;
    }
    const values = matching
      .map((r) => Number(formatUnits(r.assetsPerShare, r.underlyingDecimals)))
      .filter((v) => Number.isFinite(v) && v > 0);
    if (values.length === 0) return undefined;
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    return (hi - lo) / lo <= 1e-6 ? values[0] : undefined;
  };
}

/**
 * A base-unit amount of `units` as display text. A share with its live rate
 * reads as the underlying it is worth, converted in integers; a share without
 * one reads as loading ("… USDC", tokenAmountLabel); anything else is itself. `format` writes the figure
 * (default: every significant digit, like formatUnits).
 */
export function shareWeiText(
  wei: bigint,
  units: { symbol: string; decimals: number },
  rate: ShareRate | undefined,
  format: (wei: bigint, decimals: number, symbol: string) => string = (v, d) => formatUnits(v, d),
): string {
  if (isShareSymbol(units.symbol) && rate && rate.shareDecimals === units.decimals) {
    const assets = (wei * rate.assetsPerShare) / 10n ** BigInt(rate.shareDecimals);
    const symbol = displayTokenSymbol(rate.underlyingSymbol);
    return `${format(assets, rate.underlyingDecimals, symbol)} ${symbol}`;
  }
  return tokenAmountLabel(format(wei, units.decimals, displayTokenSymbol(units.symbol)), units.symbol);
}

/**
 * A FEE in `units` as display text, never read low: a share with its rate is
 * converted rounding UP and written with the cost formatter (also rounding up),
 * as "~0.0043 ETH"; without a rate it reads as loading ("… ETH"); a plain
 * token is its own figure, rounded up. Caps and spendable
 * figures round DOWN elsewhere; a fee is a cost, so it rounds the other way.
 */
export function feeShareText(wei: bigint, units: { symbol: string; decimals: number }, rate: ShareRate | undefined): string {
  const text = costShareText(wei, units, rate);
  return text.startsWith(LOADING_FIGURE) ? text : `~${text}`;
}

/**
 * A COST in `units` as display text ("This payment needs 1.0042 ETH"), never
 * read low: feeShareText without the estimate mark. A share with its rate is
 * converted rounding UP and written rounding up; without a rate it reads as
 * loading ("… ETH"); a plain token is itself, rounded up.
 */
export function costShareText(wei: bigint, units: { symbol: string; decimals: number }, rate: ShareRate | undefined): string {
  if (isShareSymbol(units.symbol) && rate && rate.shareDecimals === units.decimals) {
    const one = 10n ** BigInt(rate.shareDecimals);
    const product = wei * rate.assetsPerShare;
    const assets = product / one + (product % one > 0n ? 1n : 0n);
    const symbol = displayTokenSymbol(rate.underlyingSymbol);
    return `${formatShortfallAmount(assets, rate.underlyingDecimals, true, symbol)} ${symbol}`;
  }
  const symbol = displayTokenSymbol(units.symbol);
  const figure = formatShortfallAmount(wei, units.decimals, true, symbol);
  return tokenAmountLabel(figure, units.symbol);
}
