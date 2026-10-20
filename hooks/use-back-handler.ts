/**
 * Android hardware back closes the top overlay (sheet, drawer, picker) instead
 * of leaving the app. Web has no hardware back, so this is a no-op here; the
 * native version is use-back-handler.native.ts.
 */
export function useBackHandler(_active: boolean, _onBack: () => void): void {}
