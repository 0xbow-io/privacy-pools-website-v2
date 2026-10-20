import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Native: the app draws edge to edge, so overlays sit above the system nav bar. */
export function useNativeBottomInset(): number {
  return useSafeAreaInsets().bottom;
}
