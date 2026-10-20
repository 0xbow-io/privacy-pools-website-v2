import { Pressable, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

/**
 * The Uniswap-style connector between an IN card and an OUT card: a rounded
 * arrow chip that straddles the seam between the two. Ring in the page-card
 * color (reads punched through the seam), hairline border, fill matching the
 * OUT card's grey. Shared by the hub's Shield/Swap pairs and the withdraw
 * provider's inline receive card.
 *
 * With `onPress` the chip is a button (the Swap pair: press to reverse the
 * two tokens, Pat 2026-09-03); without it the chip is decoration and lets
 * presses fall through to the cards.
 *
 * The negative margins bridge whatever spacing separates the two cards down
 * to a ~6px seam. They are RUNTIME style, not -mt-[..] classes, on purpose:
 * fresh negative arbitrary margin classes have compiled to 0px in this
 * pipeline until a full rebuild, which silently breaks the overlap.
 * Defaults fit the hub (gap 12 above and below); the withdraw pair crosses
 * the inline-portal boundary (gap 12 above, 16 below) and passes its own.
 */
export function PairArrow({
  color,
  icon = 'arrow-down',
  marginTop = -28,
  marginBottom = -28,
  onPress,
  accessibilityLabel,
  testID,
}: {
  /** Glyph color — a runtime theme token (vector-icon sink). */
  color: string;
  /** Per-operation glyph: shield / globe / send; Swap keeps the arrow. */
  icon?: keyof typeof Ionicons.glyphMap;
  marginTop?: number;
  marginBottom?: number;
  /** Makes the chip a button. Omit for a purely decorative connector. */
  onPress?: () => void;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const chip = (
    <View className="rounded-[17px] bg-card-background p-[3px]">
      <View className="h-[32px] w-[32px] items-center justify-center rounded-control border border-border-light bg-background-secondary">
        <Ionicons name={icon} size={17} color={color} />
      </View>
    </View>
  );
  return (
    // nw-keep(measured-or-inset): the caller passes the exact overlap that seams
    // this arrow into the two cards it straddles.
    <View pointerEvents={onPress ? 'box-none' : 'none'} className="z-[10] items-center self-stretch" style={{ marginTop, marginBottom }}>
      {onPress ? (
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          hitSlop={6}
        >
          {chip}
        </Pressable>
      ) : chip}
    </View>
  );
}
