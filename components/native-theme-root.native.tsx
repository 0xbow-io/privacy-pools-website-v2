import type { ReactNode } from 'react';
import { View } from 'react-native';

import { useTheme } from '@/components/theme-provider';
import { NativeThemeVars } from '@/constants/theme-vars.generated';

/**
 * Root source of the `--pp-*` variables on native. Web defines them in
 * global.css; on native, NativeWind resolves `var(--pp-*)` only from a `vars()`
 * style on an ancestor View, so without this every token class (colors, fonts,
 * radii) rendered unresolved on device.
 */
export function NativeThemeRoot({ children }: { children: ReactNode }) {
  const { colorScheme } = useTheme();
  /* nw-keep(third-party-style-api): NativeWind vars() is a style object, not a class */
  return <View style={[{ flex: 1 }, NativeThemeVars[colorScheme === 'dark' ? 'dark' : 'light']]}>{children}</View>;
}
