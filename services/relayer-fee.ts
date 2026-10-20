import { approxUnderlyingText } from '@/services/share-display';
/**
 * What the relayer's fee is actually denominated in, and whether it is sane.
 *
 * THE BUG. The withdraw review rendered the fee as
 * `feeAmount / 10 ** TOKEN_DECIMALS[selectedToken]` with the SELECTED token's
 * symbol — i.e. it assumed the fee is quoted in the asset being withdrawn, and
 * never looked at what the quote said. The quote does say: `feeCommitment.asset`
 * carries the fee's asset address. Artem's review card showed
 * "Relayer fee: 499312.7542 USDC (~$499312.75)" on a 5 USDC withdrawal
 * (QA 2026-08-28) — a fee formatted against the wrong scale, which then
 * propagated into "Total Received 0.0000 USDC".
 *
 * Two separate defects live here, and both matter:
 *   1. WRONG UNITS. Resolve the fee asset from the quote and format with THAT
 *      token's decimals and symbol. If the fee is charged in the native asset
 *      while the withdrawal is USDC, the card must say so rather than silently
 *      relabelling ETH as USDC.
 *   2. AN IMPOSSIBLE FEE IS NOT A DISPLAY PROBLEM. A fee at or above the amount
 *      being withdrawn leaves the user nothing; the old card happily rendered
 *      it next to a Confirm button. Whatever the cause (relayer bug, wrong
 *      scale, stale quote), the honest response is to refuse the quote, not to
 *      draw it. `feeSanity` classifies it so the caller can block Confirm.
 *
 * PURE module: no React, no SDK, no network — decimals and metadata are
 * injected, so every case here is unit-testable.
 */

export interface FeeAssetInfo {
  symbol: string;
  decimals: number;
}

export interface ResolvedRelayerFee {
  /** Fee in whole token units of the FEE asset. */
  amount: number;
  symbol: string;
  decimals: number;
  /** True when the fee is charged in a different asset than the withdrawal. */
  isForeignAsset: boolean;
  /** Display string, e.g. "0.4993 USDC". */
  text: string;
}

/**
 * Resolve the fee against the asset the QUOTE names, falling back to the
 * withdrawn token only when the quote carries no asset (older relayers).
 */
export function resolveRelayerFee(input: {
  /** Raw base-unit fee from the quote. */
  feeAmount: string | bigint;
  /** `feeCommitment.asset` — the address the fee is denominated in. */
  feeAsset?: string | null;
  /** The token being withdrawn. */
  withdrawToken: FeeAssetInfo & { address?: string | null };
  /** Metadata lookup for the fee asset address (chain-aware, injected). */
  lookupAsset: (address: string) => FeeAssetInfo | undefined;
  /** Fraction digits for the display string. */
  displayDecimals?: number;
}): ResolvedRelayerFee {
  const { feeAmount, feeAsset, withdrawToken, lookupAsset } = input;
  const displayDecimals = input.displayDecimals ?? 4;

  const sameAddress = !!feeAsset && !!withdrawToken.address
    && feeAsset.toLowerCase() === withdrawToken.address.toLowerCase();
  // No asset on the quote, or it names the withdrawn token: use the withdrawn
  // token. Otherwise resolve the fee asset, and only fall back to the withdrawn
  // token if the lookup fails (an unknown address is not a licence to relabel
  // it — but there is nothing better to say).
  const resolved = !feeAsset || sameAddress
    ? withdrawToken
    : (lookupAsset(feeAsset) ?? withdrawToken);

  let base: bigint;
  try {
    base = BigInt(feeAmount);
  } catch {
    base = 0n;
  }
  const amount = Number(base) / 10 ** resolved.decimals;
  return {
    amount,
    symbol: resolved.symbol,
    decimals: resolved.decimals,
    // Identity is the ADDRESS when both sides have one: two contracts can share
    // a symbol (two USDCs) and are still different assets (codex on 6728c98).
    // Symbol equality is only the fallback for a withdrawn token with no address.
    isForeignAsset: !!feeAsset && (withdrawToken.address ? !sameAddress : resolved.symbol !== withdrawToken.symbol),
    text: approxUnderlyingText(`${amount.toFixed(displayDecimals)} ${resolved.symbol}`, resolved.symbol),
  };
}

export type FeeSanity = 'ok' | 'exceeds-amount' | 'implausible';

/**
 * A fee this large is a bug somewhere, not a price. Callers block Confirm on
 * anything other than 'ok'.
 *
 * `exceeds-amount`: the fee eats the whole withdrawal (received <= 0). Even if
 * the number is real, there is nothing to withdraw and submitting wastes a
 * proof.
 * `implausible`: the fee dwarfs the amount by more than `implausibleFactor`.
 * Separated from the above because it almost always means a UNIT error (a fee
 * read at the wrong decimal scale), and it deserves different copy: the user
 * cannot fix it by withdrawing more.
 */
export function feeSanity(input: {
  feeAmount: number;
  withdrawAmount: number;
  /** Fee/amount ratio above which the number is treated as a unit error. */
  implausibleFactor?: number;
}): FeeSanity {
  const { feeAmount, withdrawAmount } = input;
  const implausibleFactor = input.implausibleFactor ?? 100;
  if (!Number.isFinite(feeAmount) || feeAmount < 0) return 'implausible';
  // Nothing to judge against yet — an empty form is not a bad quote.
  if (!Number.isFinite(withdrawAmount) || withdrawAmount <= 0) return 'ok';
  if (feeAmount >= withdrawAmount * implausibleFactor) return 'implausible';
  if (feeAmount >= withdrawAmount) return 'exceeds-amount';
  return 'ok';
}

/** User-facing explanation for a refused quote. */
export function feeSanityMessage(sanity: FeeSanity, fee: ResolvedRelayerFee): string | null {
  if (sanity === 'ok') return null;
  if (sanity === 'exceeds-amount') {
    // `fee` is the BUDGETED figure (the relayer's quote plus the app's tiny re-quote
    // allowance), so it is not attributed to the relayer alone (codex on 6728c98).
    return `The fee for this withdrawal, ${fee.text} (the relayer's quote plus a tiny re-quote allowance), is the whole amount or more. Nothing would reach you, so it was not submitted. Try a larger amount, or try again shortly.`;
  }
  return `The relayer quoted a fee of ${fee.text}, which cannot be right for this withdrawal, so it was not submitted. Please report this and try again shortly.`;
}
