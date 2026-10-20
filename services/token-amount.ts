import { parseUnits } from 'viem';

/**
 * Convert a user-entered decimal string to base units exactly.
 *
 * Empty or invalid input returns 0n, matching the old `parseFloat(x) || 0`
 * behavior used by the UI. Excess fractional digits are truncated to preserve
 * the previous floor semantics without floating point math.
 */
export function parseTokenAmount(input: string, decimals: number): bigint {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === '' || trimmed === '.') {
    return 0n;
  }

  const [whole, frac = ''] = trimmed.split('.');
  const truncatedFrac = frac.slice(0, decimals);
  const normalized = truncatedFrac.length > 0 ? `${whole || '0'}.${truncatedFrac}` : (whole || '0');

  try {
    return parseUnits(normalized, decimals);
  } catch {
    return 0n;
  }
}

/**
 * Sanitize a raw amount keystroke for an amount TextInput.
 *
 * `keyboardType="numeric"` is a hint only — on web (and some Android
 * keyboards) the user can still type letters, symbols, or multiple dots by
 * paste or hardware keyboard. This strips anything that isn't part of a
 * non-negative decimal so state never holds an unparseable amount:
 *  - drops every character except digits and `.`
 *  - collapses multiple dots to the first one
 *  - clamps fractional digits to `maxDecimals` (the token's precision) when given
 *
 * Returns the cleaned string; callers feed it straight back into setState.
 */
export function sanitizeAmountInput(text: string, maxDecimals?: number): string {
  // Keep only digits and dots.
  let cleaned = text.replace(/[^0-9.]/g, '');
  // Collapse to a single decimal point (keep the first).
  const firstDot = cleaned.indexOf('.');
  if (firstDot !== -1) {
    cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
  }
  if (maxDecimals != null && firstDot !== -1) {
    const [whole, frac] = cleaned.split('.');
    cleaned = `${whole}.${frac.slice(0, Math.max(0, maxDecimals))}`;
  }
  return cleaned;
}

// Average advance of a digit in the app's sans faces, as a fraction of the font size.
const AMOUNT_GLYPH_EM = 0.6;

/**
 * Largest font size (up to `max`) at which `text` fits in `widthPx`, so a
 * long exact amount shrinks instead of being clipped. An unmeasured field
 * (`widthPx` 0) keeps `max`.
 */
export function fitAmountFontSize(text: string, widthPx: number, max: number): number {
  if (!text || widthPx <= 0) return max;
  const fit = Math.floor(widthPx / (text.length * AMOUNT_GLYPH_EM));
  return Math.max(1, Math.min(max, fit));
}
