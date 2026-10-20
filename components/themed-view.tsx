import { View, type ViewProps } from 'react-native';

import { useThemeColor } from '@/hooks/use-theme-color';

export type ThemedViewProps = ViewProps & {
  lightColor?: string;
  darkColor?: string;
};

export function ThemedView({ style, lightColor, darkColor, ...otherProps }: ThemedViewProps) {
  const backgroundColor = useThemeColor({ light: lightColor, dark: darkColor }, 'background');

  return (
    <View
      // nw-keep(data-color): scheme-resolved background honoring the caller's lightColor/darkColor overrides — runtime value, not a class token
      // nw-keep(forwarded-style-contract): caller style applies LAST (dual-run contract; className arrives via the props spread)
      style={[{ backgroundColor }, style]}
      {...otherProps}
    />
  );
}
