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
import { formatTokenBalance, isStablecoin } from '@/services/token-format';
import { displayTokenSymbol } from '@/services/share-display';

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
  let sharesWei: bigint;
  try {
    sharesWei = parseUnits(sharesExact || '0', rate.shareDecimals);
  } catch {
    // Not a decimal string this rate can convert: the caller keeps the share
    // count rather than printing a false "0.00 USDC" (codex on 0659770).
    return null;
  }
  const assets = (sharesWei * rate.assetsPerShare) / 10n ** BigInt(rate.shareDecimals);
  return Number(formatUnits(assets, rate.underlyingDecimals));
}

/**
 * USD price of the underlying, from the pools price map (keyed by lower-cased
 * address, then symbol); a stablecoin with no quote is $1. The dollar figure
 * beside a converted amount must use the SAME converted quantity × this price,
 * never shares × price (codex on 0659770).
 */
export function underlyingPriceFor(rate: ShareRate, priceMap: Record<string, number> | undefined): number {
  const byAddress = priceMap?.[rate.underlying.toLowerCase()];
  if (typeof byAddress === 'number' && byAddress > 0) return byAddress;
  const bySymbol = priceMap?.[rate.underlyingSymbol] ?? priceMap?.[rate.underlyingSymbol.toLowerCase()];
  if (typeof bySymbol === 'number' && bySymbol > 0) return bySymbol;
  // A wrapped underlying (WETH) is priced as the coin it wraps (ETH) when the
  // feed only carries the native symbol.
  const shown = displayTokenSymbol(rate.underlyingSymbol);
  const byDisplay = shown === rate.underlyingSymbol ? undefined : (priceMap?.[shown] ?? priceMap?.[shown.toLowerCase()]);
  if (typeof byDisplay === 'number' && byDisplay > 0) return byDisplay;
  return isStablecoin(rate.underlyingSymbol) ? 1 : 0;
}

/** Underlying value of a share amount already held as a number (the activity rows). */
export function shareNumberAsUnderlying(shares: number, rate: ShareRate): number {
  if (!Number.isFinite(shares)) return 0;
  return shares * Number(formatUnits(rate.assetsPerShare, rate.underlyingDecimals));
}

/** "38.10 USDC" for a share balance, at the live rate. */
export function formatShareAsUnderlying(value: number, rate: ShareRate): string {
  const symbol = displayTokenSymbol(rate.underlyingSymbol);
  return `${formatTokenBalance(value, symbol)} ${symbol}`;
}

