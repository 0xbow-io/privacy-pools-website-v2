// The Entrypoint's per-asset deposit minimum, turned into a figure the user can
// act on. Pure, bun-testable.
//
// assets(tokenId).minAmount is in the DEPOSIT asset's units. For a yield pool
// that asset is the SHARE (prod ppUSDT: 10e18 = 10 shares) while the user types
// the UNDERLYING (USDT), and the PPRouter mints shares at the vault's live
// exchange rate. So "10 USDT" is not "10 ppUSDT": on 2026-09-05 a 10 USDT
// deposit minted ~9.95 shares and the SDK's BelowMinimumAmount reached the
// toast verbatim ("value 0x8a12f83c… is below minimum 0x…8ac7230489e80000"),
// while the one surface that did convert assumed a rate of 1.0 and printed
// "10.050251256281407036 USDT (10 ppUSDT)". This module owns the conversion,
// the rounding and the copy, so every deposit surface says the same thing and
// the number it says is a number that passes.
import { formatUnits } from 'viem';
import { displayFractionDigits } from '@/services/token-format';
import { displayTokenSymbol } from '@/services/share-display';

/** ERC-4626 previewMint: the assets needed to mint exactly `shares`, rounded up. */
export const PREVIEW_MINT_ABI = [
  {
    type: 'function',
    name: 'previewMint',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: 'assets', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

/** ERC-4626 previewRedeem: the assets paid out for exactly `shares`, rounded down. */
export const PREVIEW_REDEEM_ABI = [
  {
    type: 'function',
    name: 'previewRedeem',
    inputs: [{ name: 'shares', type: 'uint256' }],
    outputs: [{ name: 'assets', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

/**
 * Discount applied to the shares a yield deposit requests for its underlying
 * budget. The SDK's sharesForUnderlying knocks 50 bps off; the app no longer
 * uses it (services/yield-deposit-safety.ts sizeWrapDeposit takes
 * previewDeposit(budget) exactly and puts a 1 ppm headroom in the spend cap
 * instead), so the underlying that clears a SHARE minimum is
 * previewMint(min) plus the buffer only. Kept as a named constant so the
 * formula reads as what it is.
 */
export const SDK_YIELD_SHARE_DISCOUNT_BPS = 0n;
/**
 * Head-room between the moment the figure is computed and the moment the
 * transaction executes: the exchange rate only grows (yield accrues) and
 * previewDeposit rounds shares DOWN while previewMint rounds assets UP, so
 * paying exactly previewMint(min) can still mint one wei short. 0.1% covers
 * both by orders of magnitude.
 */
export const MIN_DEPOSIT_BUFFER_BPS = 10n;

/** Rescale a raw amount between token decimals (18 → 6 truncates dust). */
export function scaleUnits(wei: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return wei;
  return fromDecimals > toDecimals
    ? wei / 10n ** BigInt(fromDecimals - toDecimals)
    : wei * 10n ** BigInt(toDecimals - fromDecimals);
}

/**
 * Round UP to the precision the UI prints in, so a threshold shown as
 * "10.07" is satisfied by typing 10.07. Rounding down would print a figure
 * that the contract still rejects.
 */
export function ceilToDisplayUnits(wei: bigint, decimals: number, fractionDigits: number): bigint {
  if (wei <= 0n) return 0n;
  const dropped = decimals - Math.min(fractionDigits, decimals);
  if (dropped <= 0) return wei;
  const step = 10n ** BigInt(dropped);
  return ((wei + step - 1n) / step) * step;
}

/**
 * The underlying a wallet must pay so the shares the router mints clear a
 * SHARE minimum. `assetsForMinShares` is the vault's previewMint(minShares)
 * at the live rate; the SDK discount and the buffer go on top; the result is
 * rounded UP to display precision.
 */
export function requiredUnderlyingForMinShares(input: {
  assetsForMinShares: bigint;
  underlyingDecimals: number;
  underlyingSymbol: string;
}): bigint {
  const numerator = input.assetsForMinShares * 10_000n * (10_000n + MIN_DEPOSIT_BUFFER_BPS);
  const denominator = (10_000n - SDK_YIELD_SHARE_DISCOUNT_BPS) * 10_000n;
  const exact = (numerator + denominator - 1n) / denominator;
  return ceilToDisplayUnits(exact, input.underlyingDecimals, displayFractionDigits(input.underlyingSymbol));
}

function trimTo(fixed: string, digits: number): string {
  const [whole, frac = ''] = fixed.split('.');
  const kept = frac.slice(0, digits).replace(/0+$/, '');
  return kept ? `${whole}.${kept}` : whole;
}

/**
 * "Minimum deposit is 10.07 USDT": the pay asset under its display name
 * (a share reads as its underlying), rounded UP to display precision. No
 * share parenthetical and no 18-decimal tail (Pat, 2026-09-05).
 */
export function formatDepositMinimum(minWei: bigint, decimals: number, symbol: string): string {
  const digits = displayFractionDigits(symbol);
  const ceiled = ceilToDisplayUnits(minWei, decimals, digits);
  return `Minimum deposit is ${trimTo(formatUnits(ceiled, decimals), digits)} ${displayTokenSymbol(symbol)}`;
}

/**
 * The SDK's BelowMinimumAmount message, exactly: "Below minimum amount: value
 * <n> is below minimum <n>", both amounts hex or decimal in the DEPOSIT
 * asset's raw units. Matching the whole structure (or the error's name) keeps
 * an unrelated message that merely contains "below minimum" - a quote saying
 * its output is below the minimum received, say - from being relabelled as a
 * deposit-minimum problem (codex P3 on 1a65ddb).
 */
const SDK_BELOW_MINIMUM = /Below minimum amount:\s*value\s+(0x[0-9a-f]+|\d+)\s+is below minimum\s+(0x[0-9a-f]+|\d+)/i;
export const SDK_BELOW_MINIMUM_ERROR_NAME = 'BelowMinimumAmount';

/**
 * The SDK's OTHER way of saying the same thing, thrown by the deposit and
 * reshield prepares: `Deposit value ${value} is below the Entrypoint minimum
 * ${minAmount}`, both in raw base units.
 *
 * It reached a user verbatim on 2026-09-22:
 *
 *   "Deposit value 8174139739742221932 is below the Entrypoint minimum
 *    10000000000000000000"
 *
 * which is 8.17 against a minimum of 10, in an asset the sentence never names.
 * The matcher below only knew the `BelowMinimumAmount` wording, so this one
 * passed straight through untranslated. Same capture order, so it feeds the
 * same formatter.
 */
const SDK_ENTRYPOINT_MINIMUM = /Deposit value\s+(0x[0-9a-f]+|\d+)\s+is below the Entrypoint minimum\s+(0x[0-9a-f]+|\d+)/i;
export const SDK_ENTRYPOINT_MINIMUM_ERROR_NAME = 'DepositBelowMinimum';

/**
 * Last line of defence for the SDK's BelowMinimumAmount. Prefer the pay-side
 * minimum the caller already computed; otherwise parse the minimum out of the
 * message and convert it (share units → underlying, rate ≈ 1 plus the buffer)
 * so the toast still names a figure in the asset the user typed. When the
 * caller's figure was itself an ESTIMATE (the vault's live rate could not be
 * read) the sentence says so instead of repeating the figure as authoritative
 * (codex P2 on 1a65ddb). Null for any other error, so ordinary messages pass
 * through untouched.
 */
export function friendlyDepositError(
  message: string,
  ctx: {
    payMinWei?: bigint | null;
    /** The pay-side minimum came from a rate-1 fallback, not from previewMint. */
    payMinIsEstimate?: boolean;
    payDecimals: number;
    paySymbol: string;
    /** The deposit asset the SDK measured in (the share for a yield pool). */
    poolDecimals?: number;
    poolIsShare?: boolean;
  },
  errorName?: string,
): string | null {
  const match = SDK_BELOW_MINIMUM.exec(message) ?? SDK_ENTRYPOINT_MINIMUM.exec(message);
  const named = errorName === SDK_BELOW_MINIMUM_ERROR_NAME || errorName === SDK_ENTRYPOINT_MINIMUM_ERROR_NAME;
  if (!match && !named) return null;
  const estimateNote = ' That figure is an estimate (the vault’s live rate could not be read); try a slightly higher amount.';
  if (ctx.payMinWei != null && ctx.payMinWei > 0n) {
    return formatDepositMinimum(ctx.payMinWei, ctx.payDecimals, ctx.paySymbol) + (ctx.payMinIsEstimate ? estimateNote : '');
  }
  if (!match) return `Below the pool minimum deposit for ${displayTokenSymbol(ctx.paySymbol)}.`;
  const rawMin = BigInt(match[2]);
  const poolDecimals = ctx.poolDecimals ?? ctx.payDecimals;
  const inPayUnits = scaleUnits(rawMin, poolDecimals, ctx.payDecimals);
  const minWei = ctx.poolIsShare
    ? requiredUnderlyingForMinShares({ assetsForMinShares: inPayUnits, underlyingDecimals: ctx.payDecimals, underlyingSymbol: ctx.paySymbol })
    : inPayUnits;
  // A share minimum parsed from the message is converted at rate ≈ 1: say so.
  return formatDepositMinimum(minWei, ctx.payDecimals, ctx.paySymbol) + (ctx.poolIsShare ? estimateNote : '');
}
