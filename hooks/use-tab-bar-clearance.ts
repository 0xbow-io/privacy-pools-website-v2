import { Platform, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { tabBarClearance } from '@/services/header-nav';

/** Bottom padding for a scroll view that sits behind the floating tab bar. */
export function useTabBarClearance(): number {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return tabBarClearance(Platform.OS, width, insets.bottom);
}
