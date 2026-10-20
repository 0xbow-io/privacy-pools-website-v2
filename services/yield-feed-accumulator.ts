/**
 * Growing public feeds, held across grid ticks instead of refetched whole.
 *
 * WHY THIS EXISTS. The yield feeds have to move onto the public-feed grid
 * (services/public-feed-scheduler.ts): while they were fetched from a
 * component, the request only happened when a user expanded a position's
 * yield row, so its timing said "this client just opened the yield row for a
 * position on this chain". The scheduler's own header names exactly that case.
 *
 * But the rate history is a LOG, not a snapshot: 68 KB on mainnet today and
 * one row longer every hour, forever. Re-draining it on every tick would make
 * the privacy fix cost every user a growing download they mostly already have.
 * The feed is already paginated by an opaque server row id, so a tick after
 * the first sends `?sinceId=<last row seen>` and gets back only what is new.
 *
 * THE CURSOR IS NOT USER DATA. It is the server's own row id, echoed back.
 * It is not derived from the caller's notes, balances, or screen — the rule
 * the discipline actually draws (docs/privacy-request-discipline.md). What it
 * does correlate with is how long this client has had the page open, and that
 * is the arrival time the scheduler already publishes deliberately through its
 * off-grid bootstrap. Narrowing a fetch to "only the pages covering MY notes"
 * would be the forbidden thing; resuming a public log where this client left
 * off is not.
 *
 * Pure: no client, no config, no clock. Bun tests import this directly.
 */

export type YieldFeedAccumulator<TRow> = {
  /** Every row seen so far, ascending by id. */
  rows: readonly TRow[];
  /** The resume point for the next tick; null before the first drain. */
  lastSyncedId: string | null;
  /**
   * Whether the rows are a whole feed. A drain that hit the page cap merges
   * its prefix and leaves this false: the cursor still advances, so the next
   * tick continues instead of re-fetching the same 25 pages forever, but no
   * consumer is shown a partial feed as if it were complete.
   */
  complete: boolean;
  /** When the last successful drain landed, epoch ms; null before the first. */
  syncedAt: number | null;
  /**
   * When the cursor last moved, complete drain or capped prefix, epoch ms. The
   * resume rule reads this, so a feed past the page cap continues from its
   * prefix on the next tick instead of bootstrapping forever.
   */
  progressAt: number | null;
};

export const EMPTY_YIELD_FEED_ACCUMULATOR: YieldFeedAccumulator<never> = Object.freeze({
  rows: Object.freeze([]) as readonly never[],
  lastSyncedId: null,
  complete: false,
  syncedAt: null,
  progressAt: null,
});

/**
 * May a tick resume from the stored cursor, or must it bootstrap?
 *
 * THE RULE THIS ANSWERS. docs/privacy-request-discipline.md forbids sending a
 * raw sync cursor and asks for one snapped onto a shared grid, so that every
 * client produces the same request. A cursor that is simply "wherever I got
 * to" breaks that for any client that MISSED ticks — a hidden tab the browser
 * throttled, a sleeping laptop, an offline spell, one failed request. That
 * client then sends a value no one else sends, which dates its last successful
 * tick and links its pre-gap and post-gap sessions, including across an IP
 * change. It is not note-derived, but it is per-client state on a request that
 * is otherwise identical for everyone.
 *
 * So resume only across a gap the grid itself would produce: one interval,
 * plus slack for scheduling jitter. Anything longer bootstraps, which is the
 * request a fresh client sends anyway. The cost is re-downloading the feed
 * after a long sleep, which is what the old per-query code did on every mount.
 */
export function mayResume(params: {
  syncedAt: number | null;
  now: number;
  intervalMs: number;
  /** Multiple of the interval still counted as "the previous tick". */
  slack?: number;
}): boolean {
  if (params.syncedAt == null) return false;
  const elapsed = params.now - params.syncedAt;
  // A clock that went backwards (NTP step, suspend/resume) is not evidence of
  // a recent tick.
  if (elapsed < 0) return false;
  return elapsed <= params.intervalMs * (params.slack ?? 2);
}

/**
 * A hard ceiling on retained rows, so a long-lived tab cannot grow this
 * without bound. Hourly observations, so this is ~5.7 years of history; the
 * OLDEST rows are dropped because every consumer reads recent history (an APY
 * window, or the rate at a note's timestamp, and a note older than the ceiling
 * has bigger problems).
 */
export const YIELD_FEED_MAX_RETAINED_ROWS = 50_000;

/**
 * Fold a freshly drained page-set into what we already had.
 *
 * Deduplicates by row id and keeps ascending order, because a resumed drain is
 * allowed to overlap: `sinceId` is documented as "rows with id > sinceId", but
 * a server that ever answered inclusively, or a retry that replayed a page,
 * would otherwise double-count — and for yield-earned a duplicated deposit row
 * is a wrong number on someone's money, not a cosmetic glitch.
 *
 * The cursor only ever moves FORWARD. A tick that returns nothing keeps the
 * previous cursor rather than resetting to null, so a quiet hour cannot send
 * the next tick back to a full bootstrap.
 */
export function mergeYieldFeedRows<TRow>(params: {
  prev: YieldFeedAccumulator<TRow>;
  incoming: readonly TRow[];
  /** The drain's end cursor. Ignored when it does not advance. */
  lastSyncedId: string | null;
  idOf: (row: TRow) => string;
  /**
   * The row's identity in the WORLD, independent of the feed's row id — a
   * deposit's `txHash:logIndex`, an observation's block. If the ASP ever
   * truncates and refills a feed table the ids restart, and a live client
   * would otherwise merge the same observation twice under two different ids.
   * Duplicated deposit facts are a wrong cost basis, i.e. wrong money.
   */
  keyOf?: (row: TRow) => string;
  /** false when the drain hit its page cap: rows are a prefix, not the feed. */
  complete?: boolean;
  now?: number;
  maxRows?: number;
}): YieldFeedAccumulator<TRow> {
  const maxRows = Math.max(1, Math.floor(params.maxRows ?? YIELD_FEED_MAX_RETAINED_ROWS));
  const byId = new Map<string, TRow>();
  for (const row of params.prev.rows) byId.set(params.idOf(row), row);
  // Incoming wins on a collision: a re-served row is the server's newer copy.
  for (const row of params.incoming) byId.set(params.idOf(row), row);

  let rows = [...byId.values()].sort((a, b) => compareIds(params.idOf(a), params.idOf(b)));

  // Second pass on the natural key, newest id winning, so a re-indexed feed
  // converges on one row per real-world thing instead of two.
  if (params.keyOf) {
    const byKey = new Map<string, TRow>();
    for (const row of rows) byKey.set(params.keyOf(row), row);
    rows = [...byKey.values()].sort((a, b) => compareIds(params.idOf(a), params.idOf(b)));
  }

  const trimmed = rows.length > maxRows ? rows.slice(rows.length - maxRows) : rows;
  const complete = params.complete ?? true;

  const lastSyncedId = advanceCursor(params.prev.lastSyncedId, params.lastSyncedId);
  return {
    rows: trimmed,
    lastSyncedId,
    complete,
    // Only a COMPLETE drain counts as a sync: a prefix must not make the next
    // tick think it is resuming from a settled state.
    syncedAt: complete ? (params.now ?? null) : params.prev.syncedAt,
    // Progress only when the cursor actually moved (or the feed is settled):
    // a drain that did not advance must age out into a bootstrap instead of
    // being resumed forever from the same cursor (cubic on #138).
    progressAt: complete || lastSyncedId !== params.prev.lastSyncedId
      ? (params.now ?? params.prev.progressAt)
      : params.prev.progressAt,
  };
}

/**
 * What the next tick resumes from: the stored accumulator, complete or a capped
 * prefix, when its last drain is within `mayResume`'s window; otherwise empty,
 * i.e. a bootstrap, the request a fresh client sends. One rule for every
 * client, so no client sends a cursor the grid would not produce.
 */
export function resumePoint<TRow>(
  stored: YieldFeedAccumulator<TRow> | undefined,
  now: number,
  intervalMs: number,
): YieldFeedAccumulator<TRow> {
  const empty = EMPTY_YIELD_FEED_ACCUMULATOR as YieldFeedAccumulator<TRow>;
  if (!stored || stored.lastSyncedId == null) return empty;
  return mayResume({ syncedAt: stored.progressAt, now, intervalMs }) ? stored : empty;
}

/**
 * Did the server restart its id sequence under us? A resumed first page that
 * serves a row at or below the cursor can only mean the ids were reused
 * (`sinceId` is exclusive), so the retained rows describe a feed that no
 * longer exists and the accumulator starts again.
 */
export function cursorWasInvalidated<TRow>(params: {
  cursor: string | null;
  incoming: readonly TRow[];
  idOf: (row: TRow) => string;
}): boolean {
  if (params.cursor == null || params.cursor === '') return false;
  return params.incoming.some((row) => compareIds(params.idOf(row), params.cursor as string) <= 0);
}

/** The larger of the two, numerically when both are decimal, else the newer non-empty one. */
function advanceCursor(prev: string | null, next: string | null): string | null {
  if (next == null || next === '') return prev;
  if (prev == null || prev === '') return next;
  return compareIds(next, prev) > 0 ? next : prev;
}

/** Decimal-numeric when both sides are, so "10" sorts after "9", not before it. */
export function compareIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
