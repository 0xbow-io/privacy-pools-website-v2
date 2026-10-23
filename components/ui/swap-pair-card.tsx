// The OUT side of the Uniswap-style pair as a reusable block: the shared
// PairArrow chip on the connecting axis, then a card matching the hub's
// Shield/Withdraw out-cards — role label top-right (where the pay card's
// presets sit), the big figure with the asset-hued token pill on the figure
// row, and one quiet caption line when it earns its place.
import { Platform, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { compactPhoneLayout } from '@/services/header-nav';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, TokenHues } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { PairArrow } from '@/components/ui/pair-arrow';
import { TokenNetworkIcon } from '@/components/ui/token-network-icon';
import { displayTokenSymbol } from '@/services/share-display';

export function SwapPairCard({
  label,
  symbol,
  chainId,
  onPress,
  disabled = false,
  figure,
  figureMuted = false,
  caption,
  captionTone = 'secondary',
  testID,
  straddle = false,
  icon,
}: {
  /** Role label, e.g. "Recipient receives" — rendered top-right like the pay card's presets slot. */
  label: string;
  /** Currently selected token symbol (always shown — the default is a valid choice). */
  symbol: string;
  /** Chain for the pill icon's badge. */
  chainId?: number;
  /** Opens the token selector. */
  onPress: () => void;
  disabled?: boolean;
  /**
   * The big figure: the known amount for this side, or a dash when only a
   * real quote may state it. Omit for a compact card.
   */
  figure?: string | null;
  /** Muted ink for the figure (zero / dash — not a real number yet). */
  figureMuted?: boolean;
  /** One quiet line under the figure row: state, hint, or the load-bearing warning. */
  caption?: string | null;
  captionTone?: 'secondary' | 'warning';
  testID?: string;
  /**
   * Inline-hub layout: the chip straddles the seam up into the amount card
   * above (the hub pair look). Off in the overlay modal, where the amount
   * input is a plain row the chip must not invade.
   */
  straddle?: boolean;
  /** Chip glyph override (per-operation: send/globe/shield). */
  icon?: keyof typeof Ionicons.glyphMap;
}) {
  const { colorScheme } = useTheme();
  const { width } = useWindowDimensions();
  // Phone web: a compact figure so the CTA under the pair stays above the fold.
  const tight = Platform.OS === 'web' && compactPhoneLayout(width);
  const colors = Colors[colorScheme];
  // A share reads as its coin, and the hue follows the coin (services/share-display.ts).
  const shown = displayTokenSymbol(symbol);
  const hue = TokenHues[colorScheme][shown] ?? TokenHues[colorScheme][symbol] ?? TokenHues[colorScheme].ETH;
  return (
    <View className="w-full gap-[10px]">
      {/* nw-keep(data-color): arrow glyph color is a runtime theme token (vector-icon sink) */}
      <PairArrow color={colors.text} icon={icon} marginTop={straddle ? -28 : -4} marginBottom={straddle ? -28 : -4} />
      <View className={`w-full rounded-inner bg-background-secondary ${tight ? 'gap-[6px] px-[16px] py-[12px]' : 'gap-[10px] p-[16px]'}`}>
        <View className="flex-row flex-wrap items-center justify-end gap-[8px]">
          <Text className="font-pp-sans-medium text-[12px] text-text-muted">{label}</Text>
        </View>
        <View className="flex-row items-center justify-between gap-[8px]">
          {figure != null ? (
            <Text
              numberOfLines={1}
              className={`min-w-0 flex-1 py-[2px] font-pp-sans-bold ${tight ? 'text-[26px] leading-[32px]' : 'text-[44px] leading-[52px]'} tracking-[-1px] ${figureMuted ? 'text-text-muted' : 'text-text'}`}
            >
              {figure}
            </Text>
          ) : <View className="min-w-0 flex-1" />}
          <Pressable
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={`${label}: ${shown}`}
            accessibilityState={{ disabled }}
            testID={testID}
            className={`flex-row items-center gap-[6px] rounded-pill border px-[10px] py-[5px] ${disabled ? 'opacity-60' : ''}`}
            // nw-keep(data-color): asset tint background with the shared neutral control border
            style={{ backgroundColor: hue.bg, borderColor: colors.border }}
          >
            <TokenNetworkIcon symbol={symbol} size={28} badgeSize={16} badgeTestnetLabel={false} chainId={chainId} />
            {/* nw-keep(data-color): pill text uses the runtime per-asset hue */}
            <Text className="font-pp-sans-semi-bold text-[15px]" style={{ color: hue.fg }}>{shown}</Text>
            {/* nw-keep(data-color): caret color is a runtime theme token (vector-icon sink) */}
            <Ionicons name="chevron-down" size={14} color={colors.text} />
          </Pressable>
        </View>
        {caption ? (
          <Text className={`font-pp-sans text-[12px] leading-[17px] ${captionTone === 'warning' ? 'text-warning' : 'text-text-secondary'}`}>
            {caption}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
