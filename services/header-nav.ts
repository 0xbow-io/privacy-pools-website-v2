// Top-bar destinations collapse into the bottom navigation and its More drawer.
// Keep the shared threshold aligned so tablet widths never lose page links.
export const BOTTOM_NAV_BREAKPOINT = 930;

export function showBottomNav(width: number): boolean {
  return width < BOTTOM_NAV_BREAKPOINT;
}

/** Query destinations can open a panel even when their pathname is unchanged. */
export function shouldNavigate(pathname: string, destination: string): boolean {
  return (pathname || '/') !== destination;
}

/** Collapse band an item belongs to. Items in a band collapse together. */
type Band = 'secondary' | 'primary' | 'always';

function bandOf(label: string): Band {
  // Secondary destinations collapse first — widest group, least used. `Explore`
  // rides this band through its `collapseAs` mapping in header.tsx.
  if (label === 'Ecosystem' || label === 'Payroll' || label === 'Portfolio') return 'secondary';
  if (label === 'Privacy Pools' || label === 'Assets') return 'primary';
  return 'always';
}

/**
 * Width below which a nav item collapses out of the top bar.
 *
 * Both connection states use the same conservative thresholds.
 * `wideActions` is retained for existing callers.
 */
export function navCollapseWidth(label: string, wideActions = false): number {
  // wideActions is accepted for call-site stability but the vault cluster is
  // connection-independent, so both states share one threshold per band.
  // (The Classic per-state thresholds retired with design variant 0.)
  void wideActions;
  switch (bandOf(label)) {
    case 'secondary':
      // MEASURED in-browser after the flex change (four-item nav, connected):
      //   1039px -> 87px clearance   1000px -> 68px   966px -> 51px
      // Clearance shrinks ~0.5px per 1px of viewport, so the real collision is
      // ~865px. 930 keeps ~65px of margin for a wider chip. The whole band
      // goes at once, so the nav then drops from ~550px to just the primary
      // item — which is why the primary threshold is so much lower.
      return BOTTOM_NAV_BREAKPOINT;
    case 'primary':
      // Only the primary item (~65px) remains by this point, and collapsing
      // the secondary band leaves enough room for the actions cluster:
      // 41 + 40 + 65 + 317 + 24 = ~487, plus margin.
      return 520; // connection-independent, like the band above
    default:
      return 0; // always visible
  }
}

/**
 * Split destinations between the top bar and bottom navigation using shared
 * thresholds, so no width leaves a destination in neither place.
 */
export function splitNavItems<T extends { label: string }>(
  items: readonly T[],
  width: number,
  wideActions = false,
): { visible: T[]; collapsed: T[] } {
  const visible: T[] = [];
  const collapsed: T[] = [];
  for (const item of items) {
    if (width >= navCollapseWidth(item.label, wideActions)) visible.push(item);
    else collapsed.push(item);
  }
  return { visible, collapsed };
}

/**
 * Width the LOGO side should take so the nav sits on the true centre of the
 * header, or undefined when the viewport cannot afford symmetry.
 *
 * The nav is a flex child between a 41px logo and a much wider actions
 * cluster, so "justify-center" centres it in that lopsided gap, not on the
 * page: at 1024px the three items sat ~110px left of the Shield card's axis
 * (Pat, 2026-09-04). Giving the logo side the cluster's width makes the gap
 * symmetric, and the nav lands on the axis. That costs the cluster's width
 * twice, which is exactly what made items collapse with room to spare before
 * (2026-08-28), so symmetry is only applied when the nav still fits with a
 * margin; otherwise the elastic layout (and its thresholds) stays in charge.
 */
export function navCenteringLeftWidth(input: {
  /** Inner header width (viewport capped by the max width, minus padding). */
  containerWidth: number;
  clusterWidth: number;
  navWidth: number;
  logoWidth: number;
  /** Slack to keep on each side of the nav. Default 12. */
  margin?: number;
}): number | undefined {
  const { containerWidth, clusterWidth, navWidth, logoWidth, margin = 12 } = input;
  if (!(containerWidth > 0) || !(clusterWidth > 0) || !(navWidth > 0)) return undefined;
  const side = Math.max(clusterWidth, logoWidth);
  return containerWidth - 2 * side - navWidth >= 2 * margin ? side : undefined;
}

/** Phone widths only (not tablets): the compact action widget that keeps the CTA above the fold. */
export const COMPACT_PHONE_MAX_WIDTH = 540;

export function compactPhoneLayout(width: number): boolean {
  return showBottomNav(width) && width <= COMPACT_PHONE_MAX_WIDTH;
}

/**
 * DEV-553: /explore/balances and /explore/activity on web below the bottom-nav
 * breakpoint use the app header, as Shield does. Desktop keeps the drawers and
 * native keeps its own page header.
 */
export function explorePageUsesAppHeader(platform: string, width: number): boolean {
  return platform === 'web' && showBottomNav(width);
}

/**
 * DEV-553: on phone web a transaction row is one line and a tap opens its
 * details, which hold every row action. Wider screens and native keep the menu.
 */
export function phoneTransactionRows(platform: string, width: number): boolean {
  return platform === 'web' && compactPhoneLayout(width);
}

/**
 * DEV-553 (Mike, Android MetaMask webview): the page does not opt into
 * `viewport-fit=cover`, so the browser never draws it under the status bar or
 * the navigation bar and a web safe-area inset is never real. An edge-to-edge
 * Android WebView still reports the system bars through
 * `env(safe-area-inset-*)`, and react-native-safe-area-context turned that into
 * a ~45px empty band above the header and below the tab bar. Web ignores the
 * inset; native keeps it.
 */
export function effectiveSafeAreaInset(platform: string, inset: number): number {
  if (platform === 'web') return 0;
  return Number.isFinite(inset) && inset > 0 ? inset : 0;
}

/**
 * DEV-553: gap between the floating tab bar and the screen bottom. Flush on
 * web (see effectiveSafeAreaInset). Native keeps its 8px floor over the inset.
 */
export function tabBarBottomOffset(platform: string, insetBottom: number): number {
  const inset = effectiveSafeAreaInset(platform, insetBottom);
  return platform === 'web' ? 0 : Math.max(inset, 8);
}

/** Height of the floating tab bar's track (see ExploreTabBar `trackHeight`). */
export const TAB_BAR_TRACK_HEIGHT = 48;
/** Air kept between the last element of a page and the top of the tab bar. */
export const TAB_BAR_CONTENT_GAP = 32;

/**
 * Bottom padding a page needs so its last element scrolls fully clear of the
 * floating tab bar: bar height + the bar's own offset from the screen bottom
 * (native safe-area inset / home indicator) + a gap. Zero when the bar is not
 * shown (desktop widths). The one source for every page behind the bar.
 */
export function tabBarClearance(platform: string, width: number, insetBottom: number): number {
  if (!showBottomNav(width)) return 0;
  return TAB_BAR_TRACK_HEIGHT + tabBarBottomOffset(platform, insetBottom) + TAB_BAR_CONTENT_GAP;
}
