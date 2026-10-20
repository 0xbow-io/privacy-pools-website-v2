/**
 * The pool's event snapshot: refreshed by one owner, read by everyone else.
 *
 * PURE module (no react-native/DOM/SDK imports) so bun tests exercise it
 * directly; the fetchers are injected.
 *
 * WHY A READ NEVER FETCHES. Every consumer used to pull: the note index on its
 * 30s rebuild, the SDK on every sync, the activity query on its tick, a
 * confirmed transaction expiring the copy, note import demanding one under ten
 * seconds old. Each turned "someone read the snapshot" into an ASP request at
 * that moment, and several of those moments are the user acting: a withdrawal
 * being prepared, a deposit confirming, a claim being pasted. The ASP saw the
 * request and when it came. So one owner refreshes the copy, the public feed
 * grid (services/public-feeds.ts), on wall-clock instants nothing in the app
 * moves, and a read returns the copy held, joins the refresh in flight, or
 * waits for the pool's first one. A failed refresh is retried by the owner on
 * its next instant, never by a reader.
 *
 * Within a page a refresh tops the copy up (services/snapshot-delta.ts); a new
 * page starts empty and downloads it whole. Nothing here is persisted.
 *
 * A reader may bootstrap a pool itself only when nothing owns it (tests, or a
 * build without the grid): that one fetch is the page's first, not a refresh.
 */

export type SnapshotStoreDeps<T> = {
  /** The whole payload, for a pool with nothing held. */
  fetchFull: (poolKey: string) => Promise<T>;
  /** The held copy brought up to date. Falls back to a full download itself when it cannot. */
  fetchUpdate?: (poolKey: string, held: T) => Promise<T>;
  now?: () => number;
  onDecision?: (line: string) => void;
};

type Pool<T> = {
  held?: T;
  heldAt?: number;
  inFlight?: Promise<T>;
  attempted: boolean;
  lastError?: unknown;
  waiters: Array<() => void>;
};

export function createSnapshotStore<T>(deps: SnapshotStoreDeps<T>) {
  const now = deps.now ?? (() => Date.now());
  // Keyed by POOL, never by a caller object: the SDK provider and the react
  // query both rebuild constantly.
  const pools = new Map<string, Pool<T>>();
  const poolOf = (poolKey: string): Pool<T> => {
    let pool = pools.get(poolKey);
    if (!pool) {
      pool = { attempted: false, waiters: [] };
      pools.set(poolKey, pool);
    }
    return pool;
  };

  function refresh(poolKey: string): Promise<T> {
    const pool = poolOf(poolKey);
    // Concurrent refreshes share one request.
    if (pool.inFlight) return pool.inFlight;
    pool.attempted = true;
    const held = pool.held;
    // The copy is as new as the request, not the response: anything that
    // landed while it was in flight may be missing from it.
    const requestedAt = now();
    deps.onDecision?.(`snapshot ${held !== undefined && deps.fetchUpdate ? 'UPDATE' : 'FETCH'} pool=${poolKey}`);
    const run = (async () => {
      try {
        const next = held !== undefined && deps.fetchUpdate
          ? await deps.fetchUpdate(poolKey, held)
          : await deps.fetchFull(poolKey);
        pool.held = next;
        pool.heldAt = requestedAt;
        pool.lastError = undefined;
        return next;
      } catch (error) {
        pool.lastError = error;
        throw error;
      } finally {
        pool.inFlight = undefined;
        const waiters = pool.waiters.splice(0);
        for (const wake of waiters) wake();
      }
    })();
    pool.inFlight = run;
    return run;
  }

  return {
    /** The owner's refresh, and the only path that sends a request once a pool is owned. */
    refresh,

    /**
     * The copy held, the refresh in flight, or (for a pool its owner has not
     * reached yet) the owner's first refresh. Throws the last failure when the
     * owner tried and nothing is held: the next attempt is the owner's.
     */
    async read(poolKey: string, opts: { mayBootstrap: boolean }): Promise<T> {
      const pool = poolOf(poolKey);
      if (pool.held !== undefined) return pool.held;
      if (pool.inFlight) return pool.inFlight;
      if (!pool.attempted) {
        if (opts.mayBootstrap) return refresh(poolKey);
        await new Promise<void>((resolve) => { pool.waiters.push(resolve); });
        if (pool.held !== undefined) return pool.held;
      }
      throw pool.lastError ?? new Error('event snapshot not loaded yet');
    },

    /** When the refresh behind the held copy was requested, by this client's clock. */
    heldAt(poolKey: string): number | undefined {
      return pools.get(poolKey)?.heldAt;
    },

    /** Test/ops seam: forget one pool, or all of them. */
    reset(poolKey?: string): void {
      if (poolKey === undefined) pools.clear();
      else pools.delete(poolKey);
    },
  };
}
