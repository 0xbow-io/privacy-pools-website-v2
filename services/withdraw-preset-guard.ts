import { formatUnits, parseUnits } from 'viem';

/**
 * Quick-amount presets on the Withdraw form (0.1 / 1 / 5 / 10 / 100 …) are a
 * fixed scale, not a function of the balance, so most of them exceed what a
 * small account can withdraw. Tapping one used to fill the amount and only
 * then paint "Amount exceeds your shielded balance". The guard decides which
 * presets are out of reach so the form can grey them and answer a tap with
 * the real ceiling instead.
 *
 * `maxWei` null means the spendable balance is still being resolved (or is
 * unavailable); no preset is judged out of reach then, so the chips keep
 * their current behaviour until the number exists.
 */
export function presetExceedsWithdrawMax(preset: string, maxWei: bigint | null | undefined, decimals: number): boolean {
  if (maxWei === null || maxWei === undefined) return false;
  let presetWei: bigint;
  try {
    presetWei = parseUnits(preset, decimals);
  } catch {
    return false;
  }
  return presetWei > maxWei;
}

/**
 * The toast shown when an out-of-reach preset is tapped. Uses the same
 * 6-decimal display the hub's other figures use; a ceiling that rounds to
 * zero but is not zero falls back to the exact value, so a dust balance is
 * never announced as "up to 0".
 */
export function withdrawMaxToastTitle(maxWei: bigint, decimals: number, symbol: string): string {
  const exact = formatUnits(maxWei, decimals);
  const rounded = (parseFloat(exact) || 0).toLocaleString('en-US', { maximumFractionDigits: 6 });
  const shown = rounded === '0' && maxWei > 0n ? exact : rounded;
  return `You can withdraw up to ${shown} ${symbol}.`;
}
