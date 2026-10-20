// Which asset a cross-chain Send pays out, once the list of what that route can
// deliver has changed underneath the pick. Pure, so bun tests can reach it.
import { displayTokenSymbol } from '@/services/share-display';

/**
 * The asset to keep selected from `offered`, preferring one the user would read
 * as the same coin as any of `wanted` (a share and its underlying display
 * alike, so a USDT pick survives the list becoming [FDUSD, ppUSDT]). Falls back
 * to the first offered asset, and to null only when nothing is offered.
 *
 * Returning null for a cross-chain send is what hid the bug this exists for:
 * the card kept showing the input coin with the destination's badge while no
 * asset was selected, so Review refused instead of handing off to Swap.
 */
export function preferredReceiveAsset<T extends { symbol: string }>(
  offered: readonly T[],
  wanted: readonly (string | null | undefined)[],
): T | null {
  const names = new Set(
    wanted.filter((s): s is string => !!s).map((s) => displayTokenSymbol(s).toUpperCase()),
  );
  return offered.find((t) => names.has(displayTokenSymbol(t.symbol).toUpperCase())) ?? offered[0] ?? null;
}
