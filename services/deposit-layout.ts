// Deposit-modal responsive layout rules (pure, node-testable).
//
// The 80be0d8 presentation polish gave the desktop input step a roomier
// card (width 580, minHeight 560). Classifying "desktop" by width alone
// clipped short/landscape viewports (codex P2): an 844×390 phone in
// landscape is wider than the mobile cutoff but far shorter than the
// 560px minimum, and with `overflow: 'hidden'` and no scroll container the
// CTA could sit unreachable outside the viewport. The roomy treatment now
// requires BOTH dimensions to clear their thresholds; everything else keeps
// the compact card, and the input step scrolls inside a viewport-capped
// card either way.

/** Widths at or below this render the mobile presentation (unchanged). */
export const DEPOSIT_MOBILE_MAX_WIDTH = 540;

/**
 * Minimum viewport HEIGHT for the roomy (minHeight 560) input card: the
 * 560px card plus backdrop breathing room. Below this the compact card is
 * used even on wide viewports (e.g. 844×390 landscape, 580×500 windows).
 */
export const DEPOSIT_ROOMY_MIN_VIEWPORT_HEIGHT = 640;

/**
 * Whether the deposit input step gets the roomy desktop treatment.
 * Width AND height must clear their thresholds — never width alone.
 */
export function shouldUseRoomyDepositLayout(width: number, height: number): boolean {
  return width > DEPOSIT_MOBILE_MAX_WIDTH && height >= DEPOSIT_ROOMY_MIN_VIEWPORT_HEIGHT;
}

/**
 * Viewport-based cap for the deposit card so it can never exceed the
 * screen; the input step's ScrollView scrolls whatever doesn't fit.
 */
export function depositCardMaxHeight(viewportHeight: number): number {
  return Math.max(280, viewportHeight - 24);
}
