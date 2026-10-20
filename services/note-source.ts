// Which note source is THIS account's, at a single render.
//
// The SDK provider holds one live note manager, and it belongs to whichever
// session was last committed. On a wallet switch or a sign-out the identity on
// screen changes one render BEFORE that manager is torn down: `sessionAddress`
// tracks wagmi synchronously in render, while `setNoteManager(null)` /
// re-`createSession` run in an effect a render later. For that one render the
// live manager still answers `getNotes()` with the PREVIOUS wallet's notes —
// and reporting them under the new identity is what let the balance hero cache
// one wallet's total as another's (Pat signed in with a fresh 0 ETH wallet and
// saw the previous wallet's balance, 2026-08-27).
//
// `sessionTarget` is the guard: it is set and cleared in the SAME state batch
// as the manager (createSession commits {manager, target} together; every
// teardown clears both together). So "the manager is mine" is exactly
// "sessionTarget names the account I am rendering for". Pure and address-cased
// so it is trivially testable without a DOM or the SDK.

/**
 * WHERE a live note manager's exported state may be written.
 *
 * The export blob is keyed by (address, chainId), and the only correct key is
 * the identity the MANAGER was committed for — never the identity the current
 * render happens to show. Those two come apart on an in-wallet account switch
 * (MetaMask "switch account", no disconnect): wagmi's address flips to B while
 * `poolSession` / `noteManager` are still A's until the teardown effect's state
 * updates land, so a write that takes the address from the render and the notes
 * from the manager files A's notes in B's bucket. There they PERSIST across
 * reloads and render as B's balance and B's received transfers, which is what
 * Pat hit on 2026-08-28: after switching from A to B straight in the wallet, B
 * showed A's 0.2131 ETH and A's Transfer In rows, while a fresh browser showed
 * B's true $0. The same drift applies to the chain half of the key.
 *
 * Persisting under the COMMITTED identity is both safe and lossless — that is
 * the bucket those notes came from and the bucket that account reads back. With
 * no committed session there is no identity to trust, so the caller must SKIP:
 * losing one sync's persistence is recoverable (the next sync rewrites it),
 * writing another account's bucket is not.
 *
 * `drifted` is only for logging — the write target does not depend on it.
 */
export type NotePersistDecision =
  | { action: 'persist'; address: string; chainId: number; drifted: boolean }
  | { action: 'skip'; reason: 'no-committed-session' };

export function resolveNotePersistTarget(input: {
  /** The (address, chainId) the live manager was built for. */
  committed: { address: string; chainId: number } | null | undefined;
  /** What the current render thinks the identity is. */
  renderAddress: string | null | undefined;
  renderChainId: number;
}): NotePersistDecision {
  const { committed, renderAddress, renderChainId } = input;
  if (!committed) return { action: 'skip', reason: 'no-committed-session' };
  const drifted = !renderAddress
    || renderAddress.toLowerCase() !== committed.address.toLowerCase()
    || renderChainId !== committed.chainId;
  return { action: 'persist', address: committed.address, chainId: committed.chainId, drifted };
}

/** True when the live note manager was built for `accountAddress`. */
export function managerOwnsAccount(input: {
  hasManager: boolean;
  isInitialized: boolean;
  accountAddress: string | null | undefined;
  sessionTarget: { address: string; chainId: number } | null | undefined;
}): boolean {
  const { hasManager, isInitialized, accountAddress, sessionTarget } = input;
  if (!hasManager || !isInitialized) return false;
  if (!accountAddress || !sessionTarget) return false;
  return sessionTarget.address.toLowerCase() === accountAddress.toLowerCase();
}
