// Dollar entry on the action hub.
//
// A non-stablecoin asset (ETH, BNB, cBTC, ...) shows the typed amount's dollar
// value in grey under the figure on every tab; tapping that line swaps the
// roles so the figure is typed in dollars and the token amount becomes the
// grey line, and the recommended-amount chips read in dollars too. The TOKEN
// amount stays each flow's source of truth throughout: dollar keystrokes are
// converted into it at the current price, and every other writer of the
// amount (a preset, tap-to-max, a token switch) re-derives the dollar text.
// Stablecoins skip the whole thing, since their figure already reads as
// dollars.
//
// Pure, so it is testable under the bun runner (see token-format.ts for why
// anything that reaches react-native is not).

import { isStablecoin } from '@/services/token-format';
import { sanitizeAmountInput } from '@/services/token-amount';
import { displayTokenSymbol } from '@/services/share-display';

/** Whether the hub offers dollar entry for this asset. */
export function fiatEntryAvailable(input: { symbol: string; priceUsd: number; isSui: boolean }): boolean {
  if (input.isSui) return false;
  if (isStablecoin(input.symbol)) return false;
  return Number.isFinite(input.priceUsd) && input.priceUsd > 0;
}

/** Dollar keystrokes: digits, one dot, cents at most. */
export function sanitizeUsdInput(text: string): string {
  return sanitizeAmountInput(text, 2);
}

/** A derived token amount never carries more fraction digits than this, or
 *  $15 of ETH would fill the figure with 0.004999999999999999. */
const MAX_DERIVED_FRACTION_DIGITS = 8;

/**
 * The token amount that `usdText` buys at `priceUsd`, as an amount-input
 * string. Empty when the dollars or the price are not a positive number.
 */
export function usdToTokenAmount(usdText: string, priceUsd: number, decimals: number): string {
  const usd = parseFloat(usdText);
  if (!Number.isFinite(usd) || usd <= 0 || !(priceUsd > 0)) return '';
  const digits = Math.max(0, Math.min(decimals, MAX_DERIVED_FRACTION_DIGITS));
  // FLOOR, never round to nearest. toFixed rounds up half the time, so "100"
  // typed under a $100 cap derives a token amount worth $100.00002 and the cap
  // kills the CTA with no way for the user to see why. Floored, the derived
  // amount is always worth at most the dollars typed, which is also what
  // deposit-cap.ts does on its own side (formatCapMaxTokens).
  const factor = 10 ** digits;
  return trimFractionZeros((Math.floor((usd / priceUsd) * factor) / factor).toFixed(digits));
}

/**
 * The dollar value of `amountText` at `priceUsd`, in cents, as an
 * amount-input string. Empty when either side is not a positive number.
 */
export function tokenToUsdText(amountText: string, priceUsd: number): string {
  const amount = parseFloat(amountText);
  if (!Number.isFinite(amount) || amount <= 0 || !(priceUsd > 0)) return '';
  return (amount * priceUsd).toFixed(2);
}

/** "$1,234.50" for the grey line; an empty or unparsable text reads "$0.00". */
export function formatUsdLabel(usdText: string): string {
  const usd = parseFloat(usdText) || 0;
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A recommended-amount chip in dollar mode. The chips are dollar-anchored
 * suggestions floored into the token (0.0038 ETH is "$10" of ETH, not $9.99),
 * so whole dollars from $1 up; cents only below that.
 */
export function usdChipLabel(preset: string, priceUsd: number): string {
  const usd = (parseFloat(preset) || 0) * priceUsd;
  if (!(usd > 0)) return preset;
  return `$${usd.toLocaleString('en-US', { maximumFractionDigits: usd < 1 ? 2 : 0 })}`;
}

/**
 * The destination card's caption: "Into the $ETH pool on Mainnet". Always the
 * ticker (a share reads as its coin) and the chain, so the line says what the
 * pool holds, not only where it lives. Ethereum reads as Mainnet here, the
 * way the team says it; the other chains keep their display names (Citrea,
 * BNB Chain).
 */
export function shieldDestinationLabel(pool: { symbol: string; chainId: number; chainName: string }): string {
  const chain = pool.chainId === 1 ? 'Mainnet' : pool.chainName;
  return `Into the $${displayTokenSymbol(pool.symbol)} pool on ${chain}`;
}

function trimFractionZeros(fixed: string): string {
  if (!fixed.includes('.')) return fixed;
  const trimmed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}
