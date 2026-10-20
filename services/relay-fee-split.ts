/**
 * Net-vs-gross split for a relayed spend (Send and Withdraw share the rule).
 *
 * PURE module (no react-native imports) so it is bun-testable.
 *
 * Two ways to read an amount the user typed:
 *
 * - **fee on top** (`sendExact: false`, the default): the typed amount is what
 *   the RECIPIENT receives, and the relayer fee is debited on top of it. Total
 *   leaving the balance is `entered + fee`. This can never spend a whole
 *   balance — `entered + fee` does not fit by construction — which is exactly
 *   the dead end users hit ("Send at most 0.009463 ETH", 2026-08-26).
 * - **send exact** (`sendExact: true`): the typed amount is the whole DEBIT and
 *   the fee comes out of it, so the recipient receives `entered - reserve`.
 *   Typing the full spendable balance is legal here.
 *
 * The reserve is deliberately the fee plus 25%, not the bare fee: the form
 * quotes a fee for the amount showing at that moment, and the relay re-quotes
 * later. Reserving the same headroom the input selection budgets means a
 * re-quote cannot push the total debit above the figure the user typed and
 * approved. The cost is that the recipient gets slightly less than
 * `entered - fee`, which the UI states with a "~".
 *
 * ---------------------------------------------------------------------------
 * HOW BIG THE FEE ACTUALLY IS, and why the relayer's own advertised numbers
 * mislead. Measured 2026-09-01; do not re-derive it from `/v1/details` alone.
 *
 * `/v1/details` reports, per asset, something like:
 *
 *     { "ticker": "ETH", "fixedFeeAmount": "21000", "feeBPS": "10" }
 *
 * Read naively that says "0.1%". It is not. Neither advertised figure is the
 * charge that matters:
 *
 *  1. `fixedFeeAmount` is the relayer's `flat_fee_amount`: 21000 of the
 *     asset's smallest unit, added on top. For an 18-decimal asset it is dust.
 *  2. The charge that dominates is gas: a fixed per-operation gas budget
 *     (the relayer's `RELAY_GAS_BUDGET`, about 0.85M for a transfer and 1.05M
 *     for a withdraw) multiplied by the gas price at quote time. /v1/details
 *     does not publish it. services/transfer-fee-estimate.ts reproduces it for
 *     transfers.
 *
 * So the advertised `feeBPS` is the NEGLIGIBLE term and the gas term dominates.
 * The consequence is that the same operation costs a wildly different
 * percentage depending only on size:
 *
 *     Sepolia, 0.001 ETH note   -> 0.000539 ETH fee  =  55%
 *     Citrea,  $0.44 withdrawal -> ~$0.05     fee    =  ~11%
 *     1 ETH at the same gas     -> 0.000539 ETH      =  0.054%
 *
 * That is fine at real sizes and brutal at test sizes, which is exactly what a
 * new user tries first. Never quote "0.1%" to a user as the fee, and never
 * compute an expected fee from feeBPS: both understate it by orders of
 * magnitude on small amounts. The only trustworthy number is the quote, and
 * quoting burns a fee commitment that lives ~60s (see the quote-TTL notes in
 * the withdraw/transfer flows), which is why the UI currently says
 * "0.1% plus gas" rather than a figure.
 * ---------------------------------------------------------------------------
 */

import { formatUnits } from 'viem';

/** Fee plus the 25% headroom the input-selection budget also reserves. */
export function relayFeeReserve(feeWei: bigint): bigint {
  return feeWei + feeWei / 4n;
}

/**
 * `gross - reserve`, floored to `grain` (the display granularity), never below
 * zero. Flooring keeps the figure the UI shows identical to the figure the
 * transfer submits, so the review screen cannot promise more than is sent.
 */
export function netAfterReserve(gross: bigint, reserve: bigint, grain: bigint): bigint {
  if (gross <= reserve) return 0n;
  const g = grain > 0n ? grain : 1n;
  return ((gross - reserve) / g) * g;
}

export type RelayFeeSplit = {
  /** What the recipient receives. */
  recipientWei: bigint;
  /** What leaves the sender's balance in total. */
  totalDebitWei: bigint;
  /** The reserved fee (padded), or null when no fee quote is known yet. */
  reserveWei: bigint | null;
  /**
   * Send-exact where the fee would swallow the transfer: the recipient would
   * get nothing, so the caller must block rather than submit.
   */
  belowFee: boolean;
};

/**
 * Split a typed amount into recipient / total, given a fee quote.
 *
 * `feeWei` is the raw quote; the padding is applied here so every caller
 * reserves the same headroom. Pass `feeWei: null` before a quote arrives: the
 * split then reports the typed amount unchanged with no reserve, which is what
 * the form shows while the quote is in flight.
 */
export function splitRelayFee(params: {
  entered: bigint;
  feeWei: bigint | null;
  grain: bigint;
  sendExact: boolean;
}): RelayFeeSplit {
  const { entered, feeWei, grain, sendExact } = params;
  if (feeWei == null) {
    return { recipientWei: entered, totalDebitWei: entered, reserveWei: null, belowFee: false };
  }
  const reserveWei = relayFeeReserve(feeWei);
  if (!sendExact) {
    // Fee on top: the recipient's figure is the typed one, the sender pays it
    // plus the fee. The BARE fee is debited, not the padded reserve — the
    // padding only exists to protect a send-exact subtraction.
    return { recipientWei: entered, totalDebitWei: entered + feeWei, reserveWei, belowFee: false };
  }
  const recipientWei = netAfterReserve(entered, reserveWei, grain);
  return {
    recipientWei,
    totalDebitWei: entered,
    reserveWei,
    belowFee: entered > 0n && recipientWei <= 0n,
  };
}

/**
 * Exact, readable formatting for a fee-sized figure.
 *
 * The UI's balance formatter rounds to 4 decimals (2 for stablecoins) and
 * collapses anything smaller into "<0.0001". A relayer fee lives right at that
 * scale, so a real 0.000540 fee rendered as "0.0005" cannot be added up, which
 * defeats the point of showing it. Keep the exact value, trim trailing zeros,
 * and cap at `maxDecimals` so the row stays readable.
 */
export function formatFeeUnits(wei: bigint, decimals: number, maxDecimals = 8): string {
  const raw = formatUnits(wei, decimals);
  if (!raw.includes('.')) return raw;
  const [whole, frac] = raw.split('.');
  const trimmed = frac.slice(0, maxDecimals).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole;
}
