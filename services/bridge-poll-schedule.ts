/**
 * When to ask about a cross-chain delivery, and when to stop.
 *
 * PURE and dependency-free, so bun tests can reach it: `services/swap-flows.ts`
 * pulls React Native in transitively and cannot be imported from a test at all.
 * Same split as `hub-token-catalog-rule`. swap-flows re-exports these so call
 * sites keep one import.
 *
 * A cross-chain reshield that HAD delivered was reported as untracked, and the
 * note only appeared on a manual page refresh (QA, 2026-09-22). Three things
 * were wrong:
 *
 *   - the budget was 300 ATTEMPTS. That is 35 minutes only if the loop is never
 *     rebuilt, so it measured the poll loop's life rather than the
 *     transaction's, and an unrelated re-render reset it.
 *   - one fixed 7s cadence made "keep looking longer" and "stop hammering LiFi"
 *     the same dial, so neither could move.
 *   - nothing re-read the notes while waiting, so a delivery that settled ahead
 *     of LiFi's index could not be noticed. Refreshing the page did it by hand.
 */

/** Poll cadence the guide asks for (5–10s) — the low end, while it matters. */
export const BRIDGE_POLL_INTERVAL_MS = 7_000;

/** Stop after this long, measured in WALL CLOCK rather than in attempts. */
export const BRIDGE_POLL_MAX_MS = 2 * 60 * 60 * 1_000;

/**
 * Back off once the fast window is over. A bridge that has not settled in two
 * minutes is minutes away, not seconds, so the longer window costs FEWER
 * requests than the old bounded one did rather than more.
 */
export const BRIDGE_POLL_FAST_WINDOW_MS = 2 * 60 * 1_000;
export const BRIDGE_POLL_SLOW_INTERVAL_MS = 30_000;

/**
 * A delivery still pending after this long gets a note resync alongside the
 * status poll, then one a minute. Not sooner: before that the tracker is the
 * right answer and a resync is just traffic.
 */
export const BRIDGE_RESYNC_AFTER_MS = 5 * 60 * 1_000;
export const BRIDGE_RESYNC_EVERY_MS = 60 * 1_000;

/** The cadence for a poll that started `elapsedMs` ago. */
export function bridgePollIntervalFor(elapsedMs: number): number {
  return elapsedMs < BRIDGE_POLL_FAST_WINDOW_MS
    ? BRIDGE_POLL_INTERVAL_MS
    : BRIDGE_POLL_SLOW_INTERVAL_MS;
}

/** Whether a resync is due, given how long the delivery has been pending. */
export function bridgeResyncDue(elapsedMs: number, lastResyncMs: number | null): boolean {
  if (elapsedMs < BRIDGE_RESYNC_AFTER_MS) return false;
  if (lastResyncMs === null) return true;
  return elapsedMs - lastResyncMs >= BRIDGE_RESYNC_EVERY_MS;
}
