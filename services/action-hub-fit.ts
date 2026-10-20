/**
 * Scale the home action widget so the shortcuts under it ("My balances" /
 * "My activity") are never pushed below the fold.
 *
 * Mike, 2026-09-18, on a 14" M1 Pro (1512 x 838 of content): the Shield card
 * itself fits, ending around y=780, and the shortcut row right beneath it at
 * ~823 is clipped by the bottom edge. So the widget is not overflowing on its
 * own, it is leaving no room for the row it owns. Pat: shrink the widget
 * proportionally at that height and below, desktop only, so those buttons are
 * always visible.
 *
 * PURE module: every measurement is injected, so the rule is unit-testable
 * without a viewport. The caller owns the desktop gate and the measuring.
 */

/**
 * The widget stops shrinking here. Below roughly this the amount input and the
 * CTA stop being comfortably legible, and a page that scrolls is better than
 * one that is unreadable. Chosen so Mike's 838 lands well inside the range
 * rather than on the floor.
 */
export const ACTION_HUB_MIN_SCALE = 0.82;

/** Breathing room under the shortcut row, so it is visible and not flush. */
export const ACTION_HUB_BOTTOM_GUTTER = 16;

export type ActionHubFitInput = {
  /** Visible viewport height in CSS pixels. */
  viewportHeight: number;
  /** Distance from the viewport top to the widget's top edge, unscaled. */
  hubTop: number;
  /** The widget's natural, unscaled height. */
  hubHeight: number;
  /** Everything that must stay visible below it: the shortcut row plus its gap. */
  reservedBelow: number;
  minScale?: number;
};

/**
 * The scale to apply, in (0, 1]. Returns exactly 1 when it already fits, and
 * when anything is still unmeasured: shrinking on a guess would make the
 * widget jump on first paint, which is worse than one frame of overflow.
 */
export function actionHubFitScale(input: ActionHubFitInput): number {
  const { viewportHeight, hubTop, hubHeight, reservedBelow } = input;
  const minScale = input.minScale ?? ACTION_HUB_MIN_SCALE;
  // Unmeasured or nonsensical: fail OPEN, never shrink on a guess.
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return 1;
  if (!Number.isFinite(hubHeight) || hubHeight <= 0) return 1;
  if (!Number.isFinite(hubTop) || hubTop < 0) return 1;
  if (!Number.isFinite(reservedBelow) || reservedBelow < 0) return 1;

  const available = viewportHeight - hubTop - reservedBelow - ACTION_HUB_BOTTOM_GUTTER;
  if (available >= hubHeight) return 1;
  if (available <= 0) return minScale;
  // Quantised, so a one-pixel scroll or resize jitter cannot restyle the page
  // on every frame.
  const raw = Math.floor((available / hubHeight) * 100) / 100;
  return Math.min(1, Math.max(minScale, raw));
}

/**
 * Layout height the scaled widget occupies. A transform does not change
 * layout, so without this the shortcut row would keep its original position
 * and the shrink would buy nothing.
 */
export function actionHubScaledHeight(hubHeight: number, scale: number): number | undefined {
  if (scale >= 1 || !Number.isFinite(hubHeight) || hubHeight <= 0) return undefined;
  return Math.ceil(hubHeight * scale);
}

/**
 * Pin the widget's TOP while it scales. A transform scales about the centre,
 * which would drop the top edge by half the height it loses; this lifts it
 * back so the widget shrinks downward only and the header gap stays put.
 */
export function actionHubScaleOffset(hubHeight: number, scale: number): number {
  if (scale >= 1 || !Number.isFinite(hubHeight) || hubHeight <= 0) return 0;
  return -((hubHeight * (1 - scale)) / 2);
}

/**
 * Phone web (Ameen, 2026-10-15): the primary button has to be on screen
 * without scrolling, above the floating bottom tab bar, at common phone sizes.
 */
export const PHONE_VIEWPORTS = [
  { width: 360, height: 740 },
  { width: 390, height: 844 },
  { width: 412, height: 915 },
] as const;

/** Distance from the viewport bottom to the tab bar's top edge (measured: 48, flush since DEV-553). */
export const PHONE_TAB_BAR_TOP_INSET = 48;

/** True when a CTA whose bottom edge sits at `ctaBottom` clears the tab bar. */
export function ctaClearsTabBar(viewportHeight: number, ctaBottom: number): boolean {
  if (!Number.isFinite(viewportHeight) || !Number.isFinite(ctaBottom)) return false;
  return ctaBottom <= viewportHeight - PHONE_TAB_BAR_TOP_INSET;
}

/** Air kept between the CTA's bottom edge and the tab bar's top edge. */
export const PHONE_CTA_REVEAL_GAP = 12;

/**
 * DEV-553: scroll-margin-bottom for the phone CTA, so revealing it (with
 * scrollIntoView) lands it above the floating tab bar rather than behind it.
 */
export const PHONE_CTA_SCROLL_MARGIN = PHONE_TAB_BAR_TOP_INSET + PHONE_CTA_REVEAL_GAP;

/**
 * DEV-553 (Mike, Android MetaMask webview, 0.04 typed): a validation line and
 * the recommended-amounts row grow the form, and the CTA ends up behind the
 * tab bar. True when the CTA must be scrolled into view. Fails closed on an
 * unmeasured layout: never scroll on a guess.
 */
export function ctaNeedsReveal(viewportHeight: number, ctaTop: number, ctaBottom: number): boolean {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return false;
  if (!Number.isFinite(ctaTop) || !Number.isFinite(ctaBottom) || ctaBottom <= ctaTop) return false;
  return ctaBottom > viewportHeight - PHONE_CTA_SCROLL_MARGIN;
}

/**
 * How far to scroll the page down so the CTA's bottom sits
 * PHONE_CTA_SCROLL_MARGIN above the viewport bottom. 0 when it already does
 * or when the layout is unmeasured.
 */
export function ctaRevealDelta(viewportHeight: number, ctaTop: number, ctaBottom: number): number {
  if (!ctaNeedsReveal(viewportHeight, ctaTop, ctaBottom)) return 0;
  return Math.ceil(ctaBottom - (viewportHeight - PHONE_CTA_SCROLL_MARGIN));
}
