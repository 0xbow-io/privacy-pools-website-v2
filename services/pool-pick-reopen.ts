// A pool picked on another chain from the hub's Withdraw or Send picker
// switches the chain first, then re-opens the inline flow under the picked
// token. The openers the picker closed over were built for the OLD chain, so
// calling them right after the switch checked the pick against the chain the
// user was leaving: Send reported "USDT is not available on this network. Pick
// a token manually." for USDT on Ethereum picked from Robinhood Chain, and
// both flows reset their destination to the old chain. The hub keeps the pick
// pending and re-opens it from an effect once a render carries the new chain,
// where the openers are current. Pure, so the decision is unit tested.

export type PendingPoolReopen = {
  /** The chain the pick was made on. */
  fromChainId: number;
  /** The picked pool's chain, the one the switch committed to. */
  chainId: number;
  mode: 'withdraw' | 'send';
  symbol: string;
  amount?: string;
};

/**
 * What a render on `chainId` does with a pending re-open: `open` once the
 * switch has landed, `wait` while the render still carries the old chain, and
 * `drop` when the chain moved somewhere else, so a later switch back never
 * opens a pick the user has left.
 */
export function pendingPoolReopenStep(pending: PendingPoolReopen | null, chainId: number): 'none' | 'wait' | 'open' | 'drop' {
  if (!pending) return 'none';
  if (chainId === pending.chainId) return 'open';
  if (chainId === pending.fromChainId) return 'wait';
  return 'drop';
}
