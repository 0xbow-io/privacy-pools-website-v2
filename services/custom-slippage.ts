/**
 * The rule behind the "Custom" slippage option.
 *
 * LiFi takes slippage as a fraction in the 0-1 range (the SDK types it
 * "Slippage tolerance (0-1 range)"), so a custom value is supported all the way
 * up. The ceiling here is a product decision, not a protocol one: 30% is far
 * past any honest route and is there so a typo cannot authorise handing most of
 * the swap to the market.
 *
 * Pure so it can be tested without the modal. The parser takes what a person
 * types, which is a PERCENT ("12.5"), and returns a FRACTION (0.125), because
 * that is what every consumer downstream wants.
 */

/** Product ceiling for a hand-entered slippage, as a percent. */
export const CUSTOM_SLIPPAGE_MAX_PERCENT = 30;
/** Below this a route is unlikely to fill at all; still allowed, but it is the floor. */
export const CUSTOM_SLIPPAGE_MIN_PERCENT = 0.01;

export type CustomSlippageResult =
  | { ok: true; fraction: number; percent: number }
  | { ok: false; error: string };

/**
 * Parse a typed percent into a slippage fraction.
 *
 * Rejects rather than clamps: silently turning 300 into 30 would authorise a
 * number the user never agreed to, and this value decides how much of their
 * money the route may lose.
 */
export function parseCustomSlippage(input: string): CustomSlippageResult {
  const trimmed = (input ?? '').trim().replace(/%$/, '').trim();
  if (!trimmed) return { ok: false, error: 'Enter a percentage.' };
  // No exponents, no signs, no thousands separators: a slippage is a plain
  // small decimal, and anything else is a mistake worth surfacing.
  if (!/^\d{1,3}(\.\d{1,4})?$/.test(trimmed)) return { ok: false, error: 'Enter a number, like 5 or 12.5.' };
  const percent = Number(trimmed);
  if (!Number.isFinite(percent)) return { ok: false, error: 'Enter a number, like 5 or 12.5.' };
  if (percent < CUSTOM_SLIPPAGE_MIN_PERCENT) {
    return { ok: false, error: `Use at least ${CUSTOM_SLIPPAGE_MIN_PERCENT}%.` };
  }
  if (percent > CUSTOM_SLIPPAGE_MAX_PERCENT) {
    return { ok: false, error: `The most you can set is ${CUSTOM_SLIPPAGE_MAX_PERCENT}%.` };
  }
  // Round to whole basis points: the fraction is what gets quoted, and
  // 0.0001 is finer than any route prices to.
  const fraction = Math.round(percent * 100) / 10_000;
  return { ok: true, fraction, percent };
}

/** How a slippage reads on a chip or a review row. Trailing zeros are noise. */
export function slippageLabel(fraction: number): string {
  const percent = fraction * 100;
  const rounded = Math.round(percent * 100) / 100;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
}

/** True when this value is not one of the presets, so the Custom chip owns it. */
export function isCustomSlippage(fraction: number, presets: readonly number[]): boolean {
  return !presets.some((p) => Math.abs(p - fraction) < 1e-9);
}
