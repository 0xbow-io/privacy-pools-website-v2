/**
 * Bottom safe-area inset for native overlays (sheets, toasts). Web lays these
 * out against the viewport, so this is always 0 here; the native value comes
 * from use-native-bottom-inset.native.ts.
 */
export function useNativeBottomInset(): number {
  return 0;
}
