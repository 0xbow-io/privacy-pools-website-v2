import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { HoverHint } from '@/components/ui/hover-hint';

/** The one sentence about a yield position, wherever an APY figure is shown. */
export const YIELD_POSITION_HINT = 'Aave yield position: accrues automatically into your balance.';

/** The pool header pill reads only "x% APY", so its net-of-fee note lives in the hint. */
export const YIELD_POSITION_NET_HINT = 'Aave yield position: accrues automatically into your balance. The APY shown is net of the protocol yield fee.';

/**
 * Encircled i beside every APY figure (Mike, 2026-09-21). The "Aave yield
 * position: 0.0050 ETH redeemable, accrues into your balance" line used to
 * appear inline on the Shield card and the pool page, and nowhere else, so it
 * read as random. It now lives here, one hover away from the rate it
 * explains, with the same wording everywhere and no figure (the balance the
 * yield accrues into is already on the page).
 */
export function YieldPositionHint({ size = 12, testID, hint = YIELD_POSITION_HINT }: { size?: number; testID?: string; hint?: string }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  return (
    <HoverHint hint={hint} wrap={hint !== YIELD_POSITION_HINT} testID={testID ?? 'yield-position-hint'}>
      {/* nw-keep(data-color): glyph colour is a runtime theme token (vector-icon sink) */}
      <Ionicons name="information-circle-outline" size={size} color={colors.textMuted} />
    </HoverHint>
  );
}
