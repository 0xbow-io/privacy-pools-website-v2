import { SymbolView, SymbolViewProps, SymbolWeight } from 'expo-symbols';
import { StyleProp, ViewStyle } from 'react-native';

export function IconSymbol({
  name,
  size = 24,
  color,
  style,
  weight = 'regular',
}: {
  name: SymbolViewProps['name'];
  size?: number;
  color: string;
  style?: StyleProp<ViewStyle>;
  weight?: SymbolWeight;
}) {
  return (
    <SymbolView
      weight={weight}
      // nw-keep(data-color): tint is the caller's runtime color prop (expo-symbols native sink)
      tintColor={color}
      resizeMode="scaleAspectFit"
      name={name}
      // nw-keep(third-party-style-api): expo-symbols SymbolView has no className path; prop-driven size + forwarded caller style
      style={[
        {
          width: size,
          height: size,
        },
        style,
      ]}
    />
  );
}
