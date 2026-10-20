/**
 * Top safe-area inset for native stack screens. Web pages handle their own
 * top edge, so this is always 0 here; the native value comes from
 * use-native-top-inset.native.ts.
 */
export function useNativeTopInset(): number {
  return 0;
}
