import { Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors, TokenHues } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { displayTokenSymbol } from '@/services/share-display';
import { TokenNetworkIcon } from './token-network-icon';

export function AssetSelector({ symbol, chainId, label, onPress, disabled, accessibilityLabel, testID, logoUri }: {
  symbol: string;
  chainId: number | undefined;
  label?: string;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  logoUri?: string;
}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const hue = TokenHues[colorScheme][symbol] ?? TokenHues[colorScheme].ETH;
  const Container = onPress ? Pressable : View;
  return (
    <Container
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      className="flex-row items-center gap-[6px] rounded-pill border px-[10px] py-[5px]"
      // nw-keep(data-color): shared per-asset tint and theme border.
      style={{ backgroundColor: hue.bg, borderColor: colors.border }}
    >
      <TokenNetworkIcon symbol={symbol} size={28} badgeSize={16} badgeTestnetLabel={false} chainId={chainId} logoUri={logoUri} />
      {/* nw-keep(data-color): asset text follows the same tint as the control. */}
      <Text className="font-pp-sans-semi-bold text-[15px]" style={{ color: hue.fg }}>{label ?? displayTokenSymbol(symbol)}</Text>
      {/* nw-keep(data-color): the caret uses the current theme foreground. */}
      {onPress && <Ionicons name="chevron-down" size={14} color={colors.text} />}
    </Container>
  );
}
