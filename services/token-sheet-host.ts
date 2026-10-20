/**
 * Channel for rendering a full-screen token sheet from OUTSIDE the tree that
 * asked for it.
 *
 * Why: `position: fixed` is not relative to the viewport when an ancestor has a
 * `transform` — that ancestor becomes the containing block. The action hub is
 * wrapped in an Animated.View carrying the hero's parallax scale/lift
 * (components/home/home-screen.tsx), so a sheet rendered inside the hub had its
 * full-screen scrim confined to the hub's own box: the page behind stayed
 * undimmed and the sheet looked like it belonged to the widget rather than to
 * the app. Same class of bug as the one GlobalSheets exists to solve for the
 * notification sheet, and the same fix — mount it at the root.
 *
 * The hub therefore publishes its sheet PROPS here and a root-level host
 * (components/global-sheets.tsx) renders the sheet outside every transform.
 * Callbacks travel with the props, so the hub keeps owning what a selection
 * means; only the painting moves.
 */

import type { TokenSelectSheetNetwork, TokenSelectSheetToken } from '@/components/ui/token-select-sheet';

export type TokenSheetRequest = {
  tokens: (TokenSelectSheetToken & { name?: string })[];
  networks: TokenSelectSheetNetwork[];
  selectedAddress: string;
  /** Chain the current selection lives on (disambiguates shared addresses). */
  selectedChainId?: number;
  /** null = no chain filter: list every token the caller passed. */
  activeNetworkId: number | null;
  chainId: number;
  isSui: boolean;
  title?: string;
  /** 'shielded' for spend sheets (withdraw/send/swap), 'wallet' to pay with. */
  balanceMode?: 'wallet' | 'shielded' | 'none';
  /** Let a PASTED non-catalog row be selected. Default false; see the sheet. */
  allowCustomSelection?: boolean;
  /** Pay pickers only: drop rows the wallet holds none of. See the sheet. */
  hideZeroBalances?: boolean;
  onSelectToken: (token: TokenSelectSheetToken) => void;
  onSelectNetwork: (networkId: number | null) => void;
  onClose: () => void;
};

type Handler = (request: TokenSheetRequest | null) => void;

let handler: Handler | null = null;
/** Last request published before a host existed, so mount order can't lose it. */
let pending: TokenSheetRequest | null = null;

/**
 * Register the root-level renderer. Replays anything already published, and the
 * returned unsubscribe only clears the slot if it is still ours — so an unmount
 * during a remount cannot wipe the incoming host.
 */
export function registerTokenSheetHost(next: Handler): () => void {
  handler = next;
  if (pending) next(pending);
  return () => {
    if (handler === next) handler = null;
  };
}

/** Show the sheet (or hide it, with null). */
export function requestTokenSheet(request: TokenSheetRequest | null): void {
  pending = request;
  handler?.(request);
}
