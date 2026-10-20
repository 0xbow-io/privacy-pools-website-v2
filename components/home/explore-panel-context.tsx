import { createContext, useContext, useMemo } from 'react';
import { useWindowDimensions } from 'react-native';

/**
 * Shared state between the Shield widget and the exploratory data surfaces
 * (Explore pools / My balances / All activity).
 *
 * Two separate concerns ride one context because they have the same lifetime
 * and the same provider — the panel shell:
 *
 *  1. LAYOUT WIDTH. Every data component (AllPools, AvailableAssets,
 *     MyPrivacyPools, Transactions) decides how many columns to show. They
 *     used to read `useWindowDimensions().width`, which is wrong the moment
 *     the component no longer spans the window: in the desktop split screen
 *     the panel is ~55% of the viewport, so a 1440px window would render the
 *     full-width table into an ~780px column and overflow. `useLayoutWidth()`
 *     returns the CONTAINER width when a shell provides one and falls back to
 *     the window otherwise — so Classic, which has no provider, is unchanged.
 *
 *  2. SELECTION. Picking an asset in the data panel drives the Shield widget's
 *     active token, and the widget's token drives the highlight back in the
 *     panel. Both directions run through `selection` + `selectAsset`.
 */

// ---- Split-screen geometry, shared by every surface that uses it ---------
// Desktop shows exploratory data as a SPLIT SCREEN (action widget on the left,
// data column on the right); anything narrower falls back to a bottom sheet or
// a stacked page. 1024 is the width below which a 440px widget plus a readable
// data column stop both fitting.
export const SPLIT_MIN_WIDTH = 1024;
/** Width of the action column when a page is centred with no panel open. */
export const CENTERED_MAX_WIDTH = 540;
/** Width of the whole two-column band once the split is open. */
export const SPLIT_MAX_WIDTH = 1280;
/** Width the action widget settles at on the left of the split. */
export const SPLIT_LEFT_WIDTH = 440;
export const SPLIT_GAP = 28;

/** Which shell the data components are rendering into. */
export type ExplorePanelSurface =
  /** Full page (Classic pools page). Tables at their natural width. */
  | 'page'
  /** Desktop split screen: a column beside the Shield widget. */
  | 'split'
  /** Mobile bottom sheet: stacked cards rather than wide tables. */
  | 'sheet';

/**
 * The asset/pool the two halves of the split screen agree on.
 *
 * `null` everywhere means "nothing picked from a panel" — the Shield widget
 * then keeps whatever token it already had, so opening a panel never silently
 * changes the amount the user was about to act on.
 */
export interface PanelSelection {
  /** Ticker the Shield widget should act on, e.g. `'ETH'`. */
  assetSymbol: string | null;
  /** Pool row the pick came from, when the row identified one. */
  poolId: string | null;
  /** Chain the pick came from, for cross-chain pool rows. */
  chainId: number | null;
}

export interface SelectAssetInput {
  assetSymbol: string;
  poolId?: string | null;
  chainId?: number | null;
}

export interface ExplorePanelContextValue {
  surface: ExplorePanelSurface;
  /** Measured width of the container the data components render into. */
  width: number;
  selection: PanelSelection;
  /** Panel → widget: make this the Shield widget's active asset. */
  selectAsset: (next: SelectAssetInput) => void;
}

export const EMPTY_SELECTION: PanelSelection = { assetSymbol: null, poolId: null, chainId: null };

const ExplorePanelContext = createContext<ExplorePanelContextValue | null>(null);

export function ExplorePanelProvider({
  surface,
  width,
  selection,
  selectAsset,
  children,
}: ExplorePanelContextValue & { children: React.ReactNode }) {
  const value = useMemo(
    () => ({ surface, width, selection, selectAsset }),
    [surface, width, selection, selectAsset],
  );
  return <ExplorePanelContext.Provider value={value}>{children}</ExplorePanelContext.Provider>;
}

/**
 * Null outside a panel shell — every consumer must degrade to its standalone
 * behaviour, which is what keeps the Classic pools page byte-identical.
 */
export function useExplorePanel(): ExplorePanelContextValue | null {
  return useContext(ExplorePanelContext);
}

/**
 * Width the component should lay itself out against: the container's when a
 * shell provides one, the window's otherwise.
 *
 * Data components must use this instead of `useWindowDimensions().width` for
 * column decisions. Hooks order is stable — both hooks always run.
 */
export function useLayoutWidth(): number {
  const panel = useExplorePanel();
  const { width: windowWidth } = useWindowDimensions();
  return panel && panel.width > 0 ? panel.width : windowWidth;
}

/**
 * True when data should render as vertically stacked cards instead of a wide
 * table — the mobile sheet always, and any container too narrow for columns.
 */
export function useCardLayout(): boolean {
  const panel = useExplorePanel();
  const width = useLayoutWidth();
  return panel?.surface === 'sheet' || width < 520;
}
