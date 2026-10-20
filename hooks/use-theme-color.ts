/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */

import { Colors } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

export function useThemeColor(
  props: { light?: string; dark?: string },
  colorName: keyof typeof Colors.light & keyof typeof Colors.dark
) {
  // RN's useColorScheme returns 'light' | 'dark' | 'unspecified' | null
  // | undefined. We only have palettes for 'light' and 'dark', so
  // collapse the other states into 'light'.
  const raw = useColorScheme();
  const theme: 'light' | 'dark' = raw === 'dark' ? 'dark' : 'light';
  const colorFromProps = props[theme];

  if (colorFromProps) {
    return colorFromProps;
  } else {
    return Colors[theme][colorName];
  }
}
