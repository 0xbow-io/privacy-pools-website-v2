/**
 * Canonical USD formatting. Every USD figure the UI renders should go through
 * one of these so the thousands rule, decimal places, and small-value handling
 * stay identical across the pools cards, portfolio, activity feed, and the
 * deposit/withdraw/transfer modals instead of each site re-passing its own
 * toLocaleString/toFixed options.
 *
 * Two dialects, matching the two kinds of surfaces the app has:
 *  - `formatUsd`        : stat figure ("$4.97", "$4,674.10", "$10.82k",
 *                         "$1.5M"), cents up to the cutover.
 *  - `formatUsdBalance` : a balance, never abbreviated ("$12,345.67").
 *  - `formatUsdPrecise` : exact figure with cents ("$1,234.56") for estimate
 *                         ("~$…") and detail rows where the exact number
 *                         matters more than compactness.
 */

/**
 * USD with a `$9,999.99`/`$10k` cutover. Under the cutover a figure always
 * has exactly two decimals and thousands separators, rounded DOWN like the
 * token figure beside it ("$4.97", not "$5": DEV-621), so a balance header,
 * a pool row and a shielded balance holding the same amount print the same
 * cents. Over it values abbreviate to k/M/B with up to two decimals and
 * trailing zeros stripped (e.g. "$10k", "$10.82k", "$1.5M"). A positive amount
 * below a cent surfaces as "<$0.01" so it never reads as empty.
 */
export function formatUsd(value: number): string {
  if (value >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}B`;
  }
  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`;
  }
  if (value >= 10_000) {
    return `$${(value / 1_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}k`;
  }
  return formatUsdBalance(value);
}

/**
 * A balance in USD, never abbreviated: exactly two decimals, thousands
 * separators, rounded DOWN like the token figure beside it ("$4.97",
 * "$12,345.67"). A positive amount below a cent reads "<$0.01" (DEV-621).
 */
export function formatUsdBalance(value: number): string {
  if (!Number.isFinite(value)) return '$0.00';
  if (value > 0 && value < 0.01) return '<$0.01';
  const cents = Math.floor(Math.abs(value) * 100 * (1 + 1e-12)) / 100;
  return `${value < 0 && cents > 0 ? '-' : ''}$${cents.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Precise USD: `$1,234.56` — always two decimals, thousands separators, no
 * abbreviation. Behavior-identical to the `$${x.toFixed(2)}` hand-formats it
 * replaces except that figures of $1,000+ gain their thousands separator.
 */
export function formatUsdPrecise(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
