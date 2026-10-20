// Payroll-local money and date formatting. Every fiat amount, token amount,
// and run date the payroll surfaces render goes through these so the thousands
// rule, decimal places, small-value handling, and date dialect stay identical
// across dashboard, run, and history instead of each site re-passing its own
// toLocaleString options. (App-wide USD helpers live in services/format-fiat;
// these add the display-currency and token dialects payroll needs.)

import { isStablecoin } from '@/config/tokens';
import { displayTokenSymbol } from '@/services/share-display';

// The fiat display currencies payroll can render. USD is the source of truth
// for every price in the app; EUR is a display-only conversion applied at
// format time via a USD→EUR rate (see services/fx-rate). Amounts stay USD
// everywhere internally — only the rendered figure changes.
export type FiatCurrency = 'USD' | 'EUR';
const FIAT_SYMBOL: Record<FiatCurrency, string> = { USD: '$', EUR: '€' };

/**
 * A USD amount rendered in the chosen display currency. `rate` is USD→target
 * (1 for USD); pass the cached FX rate for EUR. `precise` gives the always-two-
 * decimals form (`€1,234.56`); the default is the compact form (k/M/B, cents
 * under $1). All formatting rules are identical across currencies — only the
 * symbol and the applied rate differ — so USD and EUR read the same everywhere.
 */
export function formatFiat(
  value: number,
  currency: FiatCurrency = 'USD',
  rate = 1,
  { precise = false }: { precise?: boolean } = {},
): string {
  const symbol = FIAT_SYMBOL[currency];
  const v = currency === 'USD' ? value : value * (rate || 1);
  if (precise) return `${symbol}${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  if (v >= 1_000_000_000) return `${symbol}${(v / 1_000_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}B`;
  if (v >= 1_000_000) return `${symbol}${(v / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}M`;
  if (v >= 10_000) return `${symbol}${(v / 1_000).toLocaleString('en-US', { maximumFractionDigits: 2 })}k`;
  if (v > 0 && v < 1) return v < 0.005 ? `<${symbol}0.01` : `${symbol}${v.toFixed(2)}`;
  return `${symbol}${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/**
 * A full fiat figure (no k/M abbreviation) for headline stats: thousands
 * separators, and cents shown only when the amount is small enough for them to
 * matter. Above `centsBelow` (default $1,000) the figure rounds to whole units,
 * so a large total reads "€149,409" instead of a noisy "€149,408.89"; a small
 * one (a fee, a few-dollar balance) keeps its cents. The sub-cent guard from
 * formatFiat is preserved. `rate`/`currency` behave as in formatFiat.
 */
export function formatFiatFull(
  value: number,
  currency: FiatCurrency = 'USD',
  rate = 1,
  { centsBelow = 1000 }: { centsBelow?: number } = {},
): string {
  const symbol = FIAT_SYMBOL[currency];
  const v = currency === 'USD' ? value : value * (rate || 1);
  if (v > 0 && v < 0.005) return `<${symbol}0.01`;
  const maximumFractionDigits = Math.abs(v) < centsBelow ? 2 : 0;
  return `${symbol}${v.toLocaleString('en-US', { maximumFractionDigits })}`;
}

// The token decimal policy, in one place: stablecoins show 2 decimals,
// everything else 4 — so USDC never renders with 4 decimals in one view and 2
// in another.
function tokenDecimals(symbol: string): number {
  return isStablecoin(symbol) ? 2 : 4;
}

/**
 * A token amount as a bare number string (no symbol), with token-aware
 * precision, trailing zeros stripped, and "<0.0001" / "<0.01" for a positive
 * amount below the smallest shown unit so a real tiny balance never reads as
 * "0". Abbreviates to K/M above 1000 only when asked.
 */
export function formatTokenValue(value: number, symbol: string, { abbreviate = false }: { abbreviate?: boolean } = {}): string {
  if (abbreviate && value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abbreviate && value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  const digits = tokenDecimals(symbol);
  const threshold = Math.pow(10, -digits);
  if (value > 0 && value < threshold) return `<${threshold.toFixed(digits)}`;
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

/**
 * A token amount with its symbol: "26 USDC", "0.01 ETH", "0 ETH". Payroll
 * figures are exact, so abbreviation is off by default here.
 */
export function formatToken(value: number, symbol: string, { abbreviate = false }: { abbreviate?: boolean } = {}): string {
  // A yield share reads as its coin (services/share-display.ts).
  return `${formatTokenValue(value, symbol, { abbreviate })} ${displayTokenSymbol(symbol)}`;
}

// --- Dates ---

// Shared with Activity and Payment Requests so every list row dates alike.
export { formatShortDate, timestampToMs } from '@/services/display-date';
