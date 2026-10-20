import { expect, test } from 'bun:test';
import {
  ACTION_HUB_BOTTOM_GUTTER,
  ACTION_HUB_MIN_SCALE,
  actionHubFitScale,
  actionHubScaleOffset,
  actionHubScaledHeight,
  ctaClearsTabBar,
  ctaNeedsReveal,
  ctaRevealDelta,
  PHONE_CTA_SCROLL_MARGIN,
  PHONE_TAB_BAR_TOP_INSET,
  PHONE_VIEWPORTS,
} from '@/services/action-hub-fit';
import { compactPhoneLayout } from '@/services/header-nav';

// Mike's 14" M1 Pro, measured off his screenshot: 838 of visible content, the
// widget starting at y=100 and ending at 780, the shortcut row ~40 tall.
const MIKE = { viewportHeight: 838, hubTop: 100, hubHeight: 680, reservedBelow: 40 + 24 };

test("Mike's viewport shrinks the widget, and the shortcut row fits after it", () => {
  const scale = actionHubFitScale(MIKE);
  expect(scale).toBeLessThan(1);
  expect(scale).toBeGreaterThanOrEqual(ACTION_HUB_MIN_SCALE);
  // The whole point: widget + gap + row + gutter now lands inside the viewport.
  const used = MIKE.hubTop + MIKE.hubHeight * scale + MIKE.reservedBelow + ACTION_HUB_BOTTOM_GUTTER;
  expect(used).toBeLessThanOrEqual(MIKE.viewportHeight);
});

test('a tall viewport is left completely alone', () => {
  expect(actionHubFitScale({ ...MIKE, viewportHeight: 1400 })).toBe(1);
  // Exactly enough room is still "it fits": no shrink at the boundary.
  const exact = MIKE.hubTop + MIKE.hubHeight + MIKE.reservedBelow + ACTION_HUB_BOTTOM_GUTTER;
  expect(actionHubFitScale({ ...MIKE, viewportHeight: exact })).toBe(1);
  expect(actionHubFitScale({ ...MIKE, viewportHeight: exact - 1 })).toBeLessThan(1);
});

test('it never shrinks past the floor, however short the viewport', () => {
  for (const viewportHeight of [400, 200, 120, 1]) {
    expect(actionHubFitScale({ ...MIKE, viewportHeight })).toBe(ACTION_HUB_MIN_SCALE);
  }
});

test('unmeasured inputs fail OPEN, so the widget never jumps on first paint', () => {
  expect(actionHubFitScale({ ...MIKE, hubHeight: 0 })).toBe(1);
  expect(actionHubFitScale({ ...MIKE, viewportHeight: 0 })).toBe(1);
  expect(actionHubFitScale({ ...MIKE, hubTop: -1 })).toBe(1);
  expect(actionHubFitScale({ ...MIKE, reservedBelow: Number.NaN })).toBe(1);
  expect(actionHubFitScale({ ...MIKE, hubHeight: Number.NaN })).toBe(1);
});

test('the scale is quantised, so resize jitter cannot restyle every frame', () => {
  const a = actionHubFitScale({ ...MIKE, viewportHeight: 838 });
  const b = actionHubFitScale({ ...MIKE, viewportHeight: 838.4 });
  expect(a).toBe(b);
  expect(Math.round(a * 100)).toBe(a * 100);
});

test('the frame reserves the scaled height and the offset pins the top edge', () => {
  const scale = actionHubFitScale(MIKE);
  expect(actionHubScaledHeight(MIKE.hubHeight, scale)).toBe(Math.ceil(MIKE.hubHeight * scale));
  // Scaling about the centre drops the top by half the lost height; the offset
  // is exactly that, negated, so the widget only ever shrinks downward.
  expect(actionHubScaleOffset(MIKE.hubHeight, scale)).toBeCloseTo(-(MIKE.hubHeight * (1 - scale)) / 2, 6);
});

test('at scale 1 the wrapper adds nothing at all', () => {
  expect(actionHubScaledHeight(MIKE.hubHeight, 1)).toBeUndefined();
  expect(actionHubScaleOffset(MIKE.hubHeight, 1)).toBe(0);
  expect(actionHubScaledHeight(0, 0.9)).toBeUndefined();
  expect(actionHubScaleOffset(0, 0.9)).toBe(0);
});

// --- Solving once for the tallest tab (QA 2026-09-21).
//
// The widget's tabs are different heights and its card animates between them,
// so home-screen.tsx used to hand this function a height that changed on every
// frame of that animation and the widget zoomed its way through every tab
// switch. It now solves ONCE per layout, from the tallest height the layout
// has shown. These cover what that relies on.

// Shield, Withdraw, Send, Swap, Request: five faces, five natural heights.
const TAB_HEIGHTS = [680, 612, 596, 704, 548];

test('a scale solved for the tallest tab leaves every shorter tab fitting too', () => {
  const tallest = Math.max(...TAB_HEIGHTS);
  const scale = actionHubFitScale({ ...MIKE, hubHeight: tallest });
  for (const height of TAB_HEIGHTS) {
    const used = MIKE.hubTop + height * scale + MIKE.reservedBelow + ACTION_HUB_BOTTOM_GUTTER;
    expect(used).toBeLessThanOrEqual(MIKE.viewportHeight);
  }
});

test('the tallest tab is the only input, so switching tabs cannot restyle the page', () => {
  const tallest = Math.max(...TAB_HEIGHTS);
  const scale = actionHubFitScale({ ...MIKE, hubHeight: tallest });
  // Whichever face is on screen, the peak is the same number, so the scale is
  // the same number. Feeding the live height in instead is what moved it.
  for (const height of TAB_HEIGHTS) {
    expect(actionHubFitScale({ ...MIKE, hubHeight: Math.max(tallest, height) })).toBe(scale);
  }
  const live = TAB_HEIGHTS.map((h) => actionHubFitScale({ ...MIKE, hubHeight: h }));
  expect(new Set(live).size).toBeGreaterThan(1);
});

test('the frame still reserves only the tab on screen, so a short tab leaves no gap', () => {
  const tallest = Math.max(...TAB_HEIGHTS);
  const scale = actionHubFitScale({ ...MIKE, hubHeight: tallest });
  const shortest = Math.min(...TAB_HEIGHTS);
  // Reserved off the CURRENT height, never the peak: reserving the peak is
  // exactly the "bunch of empty space" this pair of fixes is about.
  expect(actionHubScaledHeight(shortest, scale)).toBe(Math.ceil(shortest * scale));
  expect(actionHubScaledHeight(shortest, scale)!).toBeLessThan(Math.ceil(tallest * scale));
});

// --- Phone web: the CTA above the fold (Ameen, 2026-10-15).
// The rendered CTA bounds are checked by the playwright screenshot run at each
// PHONE_VIEWPORTS size; these cover the rule and the layout switch only.

test('every listed phone size gets the compact layout', () => {
  for (const { width } of PHONE_VIEWPORTS) expect(compactPhoneLayout(width)).toBe(true);
});

test('a CTA clears the tab bar only when its bottom sits above the inset', () => {
  expect(ctaClearsTabBar(740, 740 - PHONE_TAB_BAR_TOP_INSET)).toBe(true);
  expect(ctaClearsTabBar(740, 741 - PHONE_TAB_BAR_TOP_INSET)).toBe(false);
});

test('an unmeasured CTA never counts as fitting', () => {
  expect(ctaClearsTabBar(740, Number.NaN)).toBe(false);
  expect(ctaClearsTabBar(0, 10)).toBe(false);
});

// --- DEV-553 (Mike, Android MetaMask webview): the webview's innerHeight is
// well under the screen height, and with 0.04 typed the "Exceeds your wallet
// balance" line plus the recommended-amounts row push the CTA behind the bar.
// The CTA is revealed with scrollIntoView and a scroll-margin of
// PHONE_CTA_SCROLL_MARGIN, so where it lands is derived from that margin.
const WEBVIEW_VIEWPORTS = [
  { width: 412, screen: 915, innerHeight: 780 },
  { width: 360, screen: 740, innerHeight: 620 },
  { width: 390, screen: 844, innerHeight: 710 },
] as const;

test('a revealed CTA lands above the tab bar at every webview height', () => {
  expect(PHONE_CTA_SCROLL_MARGIN).toBeGreaterThan(PHONE_TAB_BAR_TOP_INSET);
  for (const { innerHeight } of WEBVIEW_VIEWPORTS) {
    const landedBottom = innerHeight - PHONE_CTA_SCROLL_MARGIN;
    expect(ctaClearsTabBar(innerHeight, landedBottom)).toBe(true);
    // Once landed, it does not ask to be revealed again (no scroll loop).
    expect(ctaNeedsReveal(innerHeight, landedBottom - 52, landedBottom)).toBe(false);
  }
});

test('a validation line plus the recommended row behind the bar asks for a reveal', () => {
  const VALIDATION_LINE = 17; // one 12px/17px line
  const RECOMMENDED_ROW = 32;
  for (const { innerHeight } of WEBVIEW_VIEWPORTS) {
    // A CTA that just cleared the bar, then grew by the two rows.
    const before = innerHeight - PHONE_CTA_SCROLL_MARGIN;
    const after = before + VALIDATION_LINE + RECOMMENDED_ROW;
    expect(ctaClearsTabBar(innerHeight, after)).toBe(false);
    expect(ctaNeedsReveal(innerHeight, after - 52, after)).toBe(true);
  }
});

test('an unmeasured CTA is never scrolled on a guess', () => {
  expect(ctaNeedsReveal(Number.NaN, 0, 900)).toBe(false);
  expect(ctaNeedsReveal(780, 0, 0)).toBe(false);
  expect(ctaNeedsReveal(780, Number.NaN, 900)).toBe(false);
});

test('the reveal scrolls exactly enough to land the CTA above the bar', () => {
  for (const { innerHeight } of WEBVIEW_VIEWPORTS) {
    const ctaBottom = innerHeight + 49; // pushed down by the two rows
    const delta = ctaRevealDelta(innerHeight, ctaBottom - 52, ctaBottom);
    expect(ctaClearsTabBar(innerHeight, ctaBottom - delta)).toBe(true);
    expect(ctaBottom - delta).toBe(innerHeight - PHONE_CTA_SCROLL_MARGIN);
    expect(ctaRevealDelta(innerHeight, 100, 152)).toBe(0);
  }
});
