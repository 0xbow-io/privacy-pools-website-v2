/**
 * One-way channel for "open the swap modal, fully specified".
 *
 * Why not the SwapModal context? Provider order. `SwapModalProvider` is mounted
 * INSIDE `PoolsProvider` (it reads pool balances), which is itself inside
 * `TransferModalProvider` — so calling `useSwapModal()` from the transfer modal
 * reads the context DEFAULT, whose openSwapModal is a no-op. The handoff would
 * compile, render a button, and do nothing when pressed. Reordering the
 * providers to fix that would move the pools tree above three modal providers
 * for one button's sake.
 *
 * A module-level subscription is order-independent: whoever is mounted receives
 * it, and if nobody is, the request is dropped rather than silently swallowed by
 * a no-op context (callers get `false` back and can say so).
 */

export type SwapHandoffRequest = {
  /** Pool asset being spent, by symbol (e.g. 'ETH'). */
  tokenSymbol?: string;
  initialAmount?: string;
  /** Third-party payee. Omit to default to the user's own wallet. */
  recipient?: string;
  /** Desired output token address on the DESTINATION chain (pool chain by default). */
  outputTokenAddress?: string;
  /**
   * Deliver on another chain. Omit for the ordinary same-chain route.
   *
   * A cross-chain send is the swap route with a destination: the value leaves
   * the pool here and LiFi pays the recipient over there. The receiver still
   * validates the pair, so an unroutable destination is ignored rather than
   * quoted.
   */
  destinationChainId?: number;
  /**
   * Pin the modal's mode. A private route that the hub could not take (a
   * surface without the hub) must stay private: 'reshield' keeps the output a
   * note of your own instead of the modal's wallet payout.
   */
  mode?: 'wallet' | 'reshield';
  /**
   * Run inside the hub widget instead of as a modal. Set by the Send tab for a
   * private swap-send, so Review, Confirm and the result stay in the widget.
   */
  inline?: boolean;
};

/**
 * Returns whether the receiver TOOK the request. The boolean is load-bearing:
 * the swap modal refuses an unserviceable output, a mid-execution modal and a
 * failed connect, and the caller keys off it to keep its own flow open and say
 * so. Discarding it made every refusal look like acceptance (kimi BUG C).
 */
type Handler = (request: SwapHandoffRequest) => boolean;

let handler: Handler | null = null;

/**
 * Register the receiver (the swap modal provider). Returns an unsubscribe that
 * only clears the slot if it is still ours — so an unmount during a remount
 * cannot wipe the incoming provider's registration.
 */
export function registerSwapHandoff(next: Handler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/**
 * True if a receiver was mounted and took the request.
 *
 * This is the route for a swap-send that PAYS SOMEONE ELSE. Two shapes:
 *
 *   mode 'reshield' + recipient -> a PRIVATE swap-send: the output is a new
 *                shielded note FOR that registered account (reshield-and-transfer,
 *                v2-monorepo #439, and #472 for plain assets). Same chain, and only
 *                for an output a deposit can land in (a reshield target: a yield
 *                share or a plain pool asset).
 *   mode 'wallet' + recipient   -> a public payout, opened with that address
 *                filled and expanded (what Withdraw does for any other output).
 *
 * The hub's Swap tab has no recipient row yet (DEV-510), so a third party never
 * goes through `requestSwapTab`.
 *
 * It is also the fallback for a private reshield on a surface without the hub
 * (pool pages, native), with `mode: 'reshield'` and no recipient.
 */
export function requestSwap(request: SwapHandoffRequest): boolean {
  if (!handler) return false;
  return handler(request);
}

/**
 * A swap-send to YOUR OWN account is a private reshield (same chain, or across
 * for the pairs the SDK serves): the hub's Swap tab, prefilled.
 *
 * Has no `recipient` YET: the hub card has no row for one (DEV-510). The SDK can
 * name a deposit owner now (reshield-and-transfer), so a private swap-send to a
 * third party goes through `requestSwap` with `mode: 'reshield'` and a
 * `recipient`, and a public payout through `mode: 'wallet'`.
 */
export type SwapTabHandoffRequest = {
  tokenSymbol?: string;
  initialAmount?: string;
  /** Output asset, by address on the DESTINATION chain. */
  outputTokenAddress?: string;
  /** Reshield across chains. Omit for the pool chain. */
  destinationChainId?: number;
  /**
   * Pay someone else privately (DEV-510): the output lands as THEIR shielded
   * note (reshield-and-transfer). The tab takes it only for an output that
   * route can deliver (services/swap-tab-recipient.ts); otherwise it refuses.
   */
  recipient?: string;
};

type SwapTabHandler = (request: SwapTabHandoffRequest) => boolean;

let swapTabHandler: SwapTabHandler | null = null;

export function registerSwapTabHandoff(next: SwapTabHandler): () => void {
  swapTabHandler = next;
  return () => {
    if (swapTabHandler === next) swapTabHandler = null;
  };
}

/** True if the hub's Swap tab is mounted and took the request. */
export function requestSwapTab(request: SwapTabHandoffRequest): boolean {
  if (!swapTabHandler) return false;
  return swapTabHandler(request);
}

/**
 * What the Send form held when it handed a private swap-send to the swap flow.
 *
 * Leaving the swap-send without settling it (Edit, or a failure the user backs
 * out of) reopens the Send form. A fresh open resets "receive as" to the sent
 * token and clears the recipient, which turned a failed swap-send into a plain
 * same-asset transfer one tap from confirming (Mike, #219 QA). The Send form
 * takes this back on its next inline open instead. A settled swap-send clears it.
 */
export type SwapSendDraft<T = unknown> = {
  /** Session identity that made it (lowercased). Restored only to that owner. */
  owner: string;
  chainId: number;
  recipient: string;
  sendChainId: number;
  receiveAsset: T;
};

let swapSendDraft: SwapSendDraft | null = null;

export function saveSwapSendDraft(draft: SwapSendDraft): void {
  swapSendDraft = draft.owner ? { ...draft, owner: draft.owner.toLowerCase() } : null;
}

/** One-shot: returns the draft for this owner and chain and forgets it. */
export function takeSwapSendDraft(chainId: number, owner: string | null | undefined): SwapSendDraft | null {
  const draft = swapSendDraft;
  swapSendDraft = null;
  if (!draft || !owner) return null;
  return draft.chainId === chainId && draft.owner === owner.toLowerCase() ? draft : null;
}

export function clearSwapSendDraft(): void {
  swapSendDraft = null;
}
