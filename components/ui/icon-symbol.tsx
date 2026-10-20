// Fallback for using MaterialIcons on Android and web.

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { SymbolWeight, SymbolViewProps } from 'expo-symbols';
import { ComponentProps } from 'react';
import { OpaqueColorValue, type StyleProp, type TextStyle } from 'react-native';

// SymbolViewProps['name'] expanded to a per-platform object recently —
// using it directly as the key produces an unindexable union. Narrow to
// the SF-Symbol string form so the mapping has string keys again.
type IconSymbolKey = Extract<SymbolViewProps['name'], string>;
type IconMapping = Record<IconSymbolKey, ComponentProps<typeof MaterialIcons>['name']>;
type IconSymbolName = keyof typeof MAPPING;

/**
 * Add your SF Symbols to Material Icons mappings here.
 * - see Material Icons in the [Icons Directory](https://icons.expo.fyi).
 * - see SF Symbols in the [SF Symbols](https://developer.apple.com/sf-symbols/) app.
 */
const MAPPING = {
  'house.fill': 'home',
  'paperplane.fill': 'send',
  'chevron.left.forwardslash.chevron.right': 'code',
  'chevron.right': 'chevron-right',
} as IconMapping;

/**
 * An icon component that uses native SF Symbols on iOS, and Material Icons on Android and web.
 * This ensures a consistent look across platforms, and optimal resource usage.
 * Icon `name`s are based on SF Symbols and require manual mapping to Material Icons.
 */
export function IconSymbol({
  name,
  size = 24,
  color,
  style,
}: {
  name: IconSymbolName;
  size?: number;
  color: string | OpaqueColorValue;
  style?: StyleProp<TextStyle>;
  weight?: SymbolWeight;
}) {
  return (
    <MaterialIcons
      // nw-keep(data-color): icon color is the caller's runtime prop (non-class sink on a vector-icon glyph)
      color={color}
      size={size}
      name={MAPPING[name]}
      // nw-keep(third-party-style-api): @expo/vector-icons has no className path; the caller's style forwards as-is
      style={style}
    />
  );
}
