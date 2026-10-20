/**
 * Freeze a value while something is in flight, without freezing the REQUEST
 * that produces it.
 *
 * WHY THIS EXISTS. Several wallet-balance and gas reads were written as
 * a poll interval switched off while `txPending`, and `enabled` gated on it.
 * The intent was display correctness: a background refetch landing mid-send
 * would overwrite the balance the user is looking at with a pre-send figure,
 * or flicker between the two. That intent is right.
 *
 * The implementation leaked. Pausing the POLL means an RPC watching the
 * connection sees this client go quiet for exactly the length of a
 * transaction, and start again when it settles — a clean silence window
 * bracketing an on-chain event. That is the same channel as the 2026-09-10
 * disclosure, inverted: nothing is sent, and the absence is the signal.
 * L2BEAT's network-observer assessment names the balance poll specifically.
 *
 * Worth being precise, because a review caught me overstating it: of the five
 * sites this was applied to, the two `useBalance` ones had a ternary whose
 * both branches meant "no timer" (the false branch was `undefined`, and no
 * query defaults are set), so there was no window to leak. The genuine leaks
 * were the gas-fee poll and the two `enabled` gates, which
 * disabled the read for the transaction and then refetched the moment it
 * settled: a burst timed to the on-chain event, which is the same channel
 * pointing the other way.
 *
 * So the gate moves from "whether we ask" to "whether we apply". The request
 * keeps its fixed cadence and looks identical to an observer whatever the user
 * is doing; the UI holds the last value it had until the transaction settles.
 *
 * Pure and framework-free so a bun test can drive the whole state machine;
 * hooks/use-latched-while.ts is the two-line React wrapper.
 */

export type LatchState<T> = {
  /** The value the UI should show. */
  readonly value: T | undefined;
  /** Internal: what was held when the latch closed. */
  readonly held: T | undefined;
  /** Internal: was the latch closed on the previous step? */
  readonly wasFrozen: boolean;
  /** Internal: whose value this is — see `identity` on stepLatch. */
  readonly identity: string;
};

export function initialLatch<T>(): LatchState<T> {
  return { value: undefined, held: undefined, wasFrozen: false, identity: '' };
}

/**
 * Advance the latch one step.
 *
 * Closed (`frozen`), it reports whatever was showing when it closed — including
 * `undefined`, if nothing had loaded yet, because inventing a figure mid-send is
 * worse than showing none. Open, it reports the live value and tracks it.
 *
 * Re-opening takes the live value immediately rather than the held one: by then
 * the transaction has settled and the next poll is the truth. There is
 * deliberately no "refetch on unfreeze" — that would put a request on the wire
 * timed to the settlement, which is the same leak the other way round.
 */
export function stepLatch<T>(
  prev: LatchState<T>,
  live: T | undefined,
  frozen: boolean,
  /**
   * WHOSE value this is — an address, a chain, whatever the query is keyed by.
   * A latch has no idea what it holds, so without this it will happily show
   * account A's balance under account B's name: switch accounts in the wallet
   * while a transaction is in flight and the frozen figure just stays there.
   * A change resets the latch, so the UI shows nothing (or the live value)
   * rather than a stranger's number.
   */
  identity = '',
): LatchState<T> {
  const base = prev.identity === identity ? prev : initialLatch<T>();
  if (!frozen) return { value: live, held: live, wasFrozen: false, identity };
  // Closing edge: keep what was on screen. Already closed: keep holding it.
  const held = base.wasFrozen ? base.held : base.value;
  return { value: held, held, wasFrozen: true, identity };
}
