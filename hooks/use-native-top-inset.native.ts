import { useSafeAreaInsets } from 'react-native-safe-area-context';

/** Native: pushed stack screens start below the status bar. */
export function useNativeTopInset(): number {
  return useSafeAreaInsets().top;
}
