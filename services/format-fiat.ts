/**
 * Canonical USD formatting. Every USD figure the UI renders should go through
 * one of these so the thousands rule, decimal places, and small-value handling
 * stay identical across the pools cards, portfolio, activity feed, and the
 * deposit/withdraw/transfer modals instead of each site re-passing its own
 * toLocaleString/toFixed options.
 *
 * Two dialects, matching the two kinds of surfaces the app has:
 *  - `formatUsd`        — compact stat figure ("$4,674", "$10.82k", "$1.5M")
 *                         for cards and columns where space matters.
 *  - `formatUsdPrecise` — exact figure with cents ("$1,234.56") for estimate
 *                         ("~$…") and detail rows where the exact number
 *                         matters more than compactness.
 */

/**
 * Compact USD with a `$9,999`/`$10k` cutover. Under the cutover values get an
 * integer with thousands separators (no decimals, so "$4,674.1" can't wrap
 * mid-number in narrow columns); over it values abbreviate to k/M/B with up
 * to two decimals and trailing zeros stripped (e.g. "$10k", "$10.82k",
 * "$1.5M"). Sub-dollar amounts (e.g. small SUI balances on testnet) would
 * otherwise round to "$0" and read as empty, so cents show under $1 and a
 * positive amount below a cent surfaces as "<$0.01".
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
  if (value > 0 && value < 1) {
    return value < 0.005 ? '<$0.01' : `$${value.toFixed(2)}`;
  }
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/**
 * Precise USD: `$1,234.56` — always two decimals, thousands separators, no
 * abbreviation. Behavior-identical to the `$${x.toFixed(2)}` hand-formats it
 * replaces except that figures of $1,000+ gain their thousands separator.
 */
export function formatUsdPrecise(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
