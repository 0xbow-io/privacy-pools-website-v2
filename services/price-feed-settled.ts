/**
 * "Has the price grid answered yet?" — the signal that replaces `useQuery`'s
 * `isPending` for anything gated on a price.
 *
 * WHY THIS EXISTS. On 2026-09-18 the deposit modal moved off its own price
 * query and onto the public-feed grid, and its "still loading" flag was
 * inferred from `Object.keys(priceMap).length === 0`. That inference is wrong:
 * an EMPTY MAP IS A VALID ANSWER. The dev ASP prices every Sepolia token at
 * "0.00", the merge drops non-positive rows, and the feed publishes a perfectly
 * good `{}`. The flag therefore never cleared, the modal's inline auto-confirm
 * waited on it forever, and a real payment never reached a terminal state
 * (e2e: "Private payment did not reach a terminal state within 7 minutes").
 *
 * The distinction that matters is STATUS, not contents:
 *
 *   empty  -> the feed has never run. Genuinely unknown; waiting is correct.
 *   ready  -> it ran. `{}` here means "no prices on this chain", which is an
 *             answer, and the caller must act on it rather than wait.
 *   error  -> it ran and failed. Also an answer; waiting cannot improve it.
 *
 * PURE module: statuses are injected, so every branch is unit-testable without
 * a scheduler, a viewport or a clock.
 */

export type PriceFeedStatus = 'empty' | 'ready' | 'error';

/**
 * True once ANY feed has answered.
 *
 * Any, not every: the maps are merged, so one chain answering already gives the
 * caller a usable map, and a single chain whose feed is wedged must not hold
 * every other chain's UI in a loading state forever. The failure being fixed
 * here was exactly an unbounded wait, so this errs toward proceeding.
 */
export function priceFeedsSettled(statuses: readonly PriceFeedStatus[]): boolean {
  if (statuses.length === 0) return true; // nothing to wait for
  return statuses.some((status) => status !== 'empty');
}

/**
 * The deadline that makes the wait bounded no matter what.
 *
 * A component can render outside the tree that starts the scheduler, in which
 * case every status stays `empty` and nothing will ever change it. `isPending`
 * always resolved; this must too. After this long, treat the grid as having
 * answered with nothing and let the caller's own no-price rule apply — for a
 * deposit that is `checkDepositCap` failing closed with a visible message,
 * which is a refusal the user can see and act on, never a spinner that never
 * ends.
 */
export const PRICE_FEED_SETTLE_DEADLINE_MS = 12_000;

/** `priceFeedsSettled`, with the deadline applied. */
export function priceFeedsSettledBy(
  statuses: readonly PriceFeedStatus[],
  elapsedMs: number,
  deadlineMs: number = PRICE_FEED_SETTLE_DEADLINE_MS,
): boolean {
  return priceFeedsSettled(statuses) || elapsedMs >= deadlineMs;
}
