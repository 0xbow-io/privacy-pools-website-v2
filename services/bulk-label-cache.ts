/**
 * Root-validated cache for the ASP's approved-label (association-set) leaves.
 *
 * PURE module - no react-native/DOM/SDK imports - so bun tests can exercise it
 * directly. services/public-asp-cache.ts wires the real fetchers in.
 *
 * Why it exists, and why it is tested: the leaf set is ~525KB on Sepolia while
 * the root that changes whenever a leaf is appended is 87 bytes, so validating
 * by root instead of by a clock removes almost all of the traffic without
 * changing how quickly an approval is noticed. Two failure modes have both
 * actually happened here, which is why each has a test:
 *
 *  1. BURST DEDUPE. Discovery asks for ~200 labels at once. Every miss must
 *     await the SAME in-flight promise. A version that awaited the root probe
 *     before the in-flight check made all 200 callers miss it and fetch 525KB
 *     each (measured: 125 fetches on one balance load).
 *  2. BOUNDED STALENESS. When the root probe is unavailable there is no change
 *     detection, so the cache must fall back to a time-based TTL rather than
 *     serving one set forever.
 */

export type LeafSource = { getLeaves: () => Promise<readonly string[]> };

export type BulkLabelCacheDeps = {
  /** Cheap change token for the set; null when unavailable. */
  fetchRoot: (chainId: number) => Promise<string | null>;
  /** Canonical form for a leaf, applied before it enters the set. */
  mapLeaf: (leaf: string) => string;
  /** Fallback staleness bound used only when fetchRoot yields null. */
  ttlMs: number;
  now?: () => number;
  /**
   * Optional diagnostic. Called with a one-line reason whenever the cache
   * decides to fetch or to serve from memory. Two wrong guesses about why this
   * cache still refetched were settled by this hook, not by reading the code.
   */
  onDecision?: (line: string) => void;
  /**
   * Optional durable store for the fetched set, injected so this module stays
   * pure. Safe to back with localStorage: the association set is the WHOLE
   * pool's public data, identical for every client, and says nothing about
   * which notes belong to whom. That is the opposite of the account export,
   * which holds plaintext note secrets and must never leave sessionStorage.
   *
   * Reads are keyed by pool AND root, so a changed root can never serve a
   * stale set - there is no expiry to get wrong.
   */
  store?: {
    read: (poolKey: string, root: string) => readonly string[] | null;
    write: (poolKey: string, root: string, list: readonly string[]) => void;
    remove: (poolKey: string) => void;
  };
  /**
   * Whether an owner refreshes this chain's set on its own schedule (the feed
   * grid, services/public-asp-cache.ts). For an owned chain, `leaves` never
   * probes or fetches: it returns what the owner's last `refresh` brought, or
   * waits for its first one. The SDK reads the set while it prepares every
   * spend proof, so a probe from a read is an ASP request timed to the spend.
   */
  owns?: (chainId: number) => boolean;
  ownedReadWaitMs?: number;
};

export type RejectedLabelCacheDeps = {
  ttlMs: number;
  now?: () => number;
};

type RejectedLabelEntry = {
  at: number;
  set: ReadonlySet<string> | null;
  inFlight: Promise<ReadonlySet<string> | null> | null;
};

/**
 * Short-lived cache for the ASP's rejected-label set.
 *
 * Unlike the append-only approved set below, a rejection does not necessarily
 * rotate the association-set root. Funds-moving boundaries can therefore ask
 * for a forced-fresh response. A forced lookup skips only the TTL: it still
 * joins an already-running request so concurrent callers never fan out into
 * duplicate pool-wide downloads.
 */
export function createRejectedLabelCache(deps: RejectedLabelCacheDeps) {
  const now = deps.now ?? (() => Date.now());
  const entries = new Map<string, RejectedLabelEntry>();

  return {
    async get(
      poolKey: string,
      fetchSet: () => Promise<ReadonlySet<string> | null>,
      options: { forceFresh?: boolean } = {},
    ): Promise<ReadonlySet<string> | null> {
      const cached = entries.get(poolKey);
      if (cached?.inFlight) return cached.inFlight;
      if (!options.forceFresh && cached && now() - cached.at < deps.ttlMs) return cached.set;

      const inFlight = (async (): Promise<ReadonlySet<string> | null> => {
        try {
          const set = await fetchSet();
          entries.set(poolKey, { at: now(), set, inFlight: null });
          return set;
        } catch (err) {
          entries.set(poolKey, {
            at: cached?.at ?? 0,
            set: cached?.set ?? null,
            inFlight: null,
          });
          throw err;
        }
      })();
      entries.set(poolKey, {
        at: cached?.at ?? 0,
        set: cached?.set ?? null,
        inFlight,
      });
      return inFlight;
    },
  };
}

type Entry = {
  at: number;
  root: string | null;
  /** Mapped leaves in SERVED ORDER. Order is load-bearing: the SDK builds the
   *  association-set tree from this list, so leaf index must not shift. */
  list: readonly string[];
  set: Set<string>;
  inFlight: Promise<readonly string[]> | null;
};

type RootProbe = { at: number; root: string | null; inFlight: Promise<string | null> | null };

/** One chain's owner: the pool it refreshes, and whether that has produced a set yet. */
type Owner = {
  poolKey?: string;
  attempted: boolean;
  held: boolean;
  lastError?: unknown;
  waiters: Set<() => void>;
};

/** How long a read of an owned chain waits for the owner's next refresh when
 * nothing is held. One association-set grid period (60s) plus slack. */
export const OWNED_READ_WAIT_MS = 75_000;

export function createBulkLabelCache(deps: BulkLabelCacheDeps) {
  const now = deps.now ?? (() => Date.now());
  // Keyed by POOL, not by provider identity. The set is a property of the pool,
  // and the SDK provider object is rebuilt on every session build - a WeakMap on
  // the provider therefore started cold each time and refetched 525KB, which is
  // why a root-gated cache still showed six fetches per load. Two pools must
  // still never share a set or await each other's fetch, which the key gives us.
  const entries = new Map<string, Entry>();
  const rootProbes = new Map<number, RootProbe>();
  const owners = new Map<number, Owner>();
  const ownerOf = (chainId: number): Owner => {
    let owner = owners.get(chainId);
    if (!owner) {
      owner = { attempted: false, held: false, waiters: new Set() };
      owners.set(chainId, owner);
    }
    return owner;
  };

  /** Root probe, itself shared within the TTL so a burst costs one 87-byte GET. */
  async function currentRoot(chainId: number, fresh = false): Promise<string | null> {
    const cached = rootProbes.get(chainId);
    if (cached?.inFlight) return cached.inFlight;
    if (!fresh && cached && now() - cached.at < deps.ttlMs) return cached.root;
    const inFlight: Promise<string | null> = Promise.resolve().then(async () => {
      let root: string | null = null;
      try {
        root = await deps.fetchRoot(chainId);
      } catch {
        root = null;
      }
      if (rootProbes.get(chainId)?.inFlight === inFlight) {
        rootProbes.set(chainId, { at: now(), root, inFlight: null });
      }
      return root;
    });
    rootProbes.set(chainId, { at: 0, root: cached?.root ?? null, inFlight });
    return inFlight;
  }

  function settle(poolKey: string, next: Partial<Entry>, flight: Promise<readonly string[]>): boolean {
    const cur = entries.get(poolKey);
    if (cur?.inFlight !== flight) return false;
    entries.set(poolKey, {
      at: next.at ?? cur?.at ?? 0,
      root: next.root === undefined ? (cur?.root ?? null) : next.root,
      list: next.list ?? cur?.list ?? [],
      set: next.set ?? cur?.set ?? new Set<string>(),
      inFlight: null,
    });
    return true;
  }

  function invalidate(chainId: number, poolKey: string): void {
    entries.delete(poolKey);
    rootProbes.delete(chainId);
    deps.store?.remove(poolKey);
    const owner = owners.get(chainId);
    if (owner?.poolKey === poolKey) owner.held = false;
  }

  /** An owned chain's set as its owner last left it. Never a request. */
  async function readOwned(chainId: number, poolKey: string): Promise<readonly string[]> {
    const owner = ownerOf(chainId);
    if (owner.poolKey !== undefined && owner.poolKey !== poolKey) {
      throw new Error(`association set for ${poolKey} is not the pool the owner refreshes (${owner.poolKey})`);
    }
    const entry = entries.get(poolKey);
    if (owner.held && entry) return entry.list;
    // Bound the FIRST refresh and a hung in-flight refresh too. Failed ticks
    // do not reject the reader: only a successful owner refresh or the deadline
    // settles it. Remove the waiter on timeout, even if the owner never runs.
    return new Promise<readonly string[]>((resolve, reject) => {
      const finish = () => {
        const next = entries.get(poolKey);
        if (owner.poolKey !== undefined && owner.poolKey !== poolKey) {
          clearTimeout(timer);
          owner.waiters.delete(finish);
          reject(new Error(`association set for ${poolKey} is not the pool the owner refreshes (${owner.poolKey})`));
          return;
        }
        if (!owner.held || !next) return;
        clearTimeout(timer);
        owner.waiters.delete(finish);
        resolve(next.list);
      };
      const timer = setTimeout(() => {
        owner.waiters.delete(finish);
        reject(owner.lastError ?? new Error('association set not loaded yet'));
      }, deps.ownedReadWaitMs ?? OWNED_READ_WAIT_MS);
      owner.waiters.add(finish);
    });
  }

  function load(source: LeafSource, chainId: number, poolKey: string, freshRoot: boolean): Promise<readonly string[]> {
    const entry = entries.get(poolKey);
    // Dedupe BEFORE any await - see failure mode 1 in the module docs.
    // Anything that needs awaiting belongs inside the promise below.
    if (entry?.inFlight) return entry.inFlight;

    const inFlight: Promise<readonly string[]> = Promise.resolve().then(async () => {
      try {
        const root = await currentRoot(chainId, freshRoot);
        const cur = entries.get(poolKey);
        const stillValid = cur !== undefined && cur.list.length > 0
          && (root !== null ? cur.root === root : now() - cur.at < deps.ttlMs);
        if (stillValid) {
          deps.onDecision?.(`leaf-cache HIT pool=${poolKey} root=${String(root).slice(0, 12)} n=${cur.list.length}`);
          settle(poolKey, { at: cur.at, root: cur.root, list: cur.list, set: cur.set }, inFlight);
          return cur.list;
        }
        // Durable store next: a cold tab can have an empty memory map but a
        // valid persisted set for this exact root.
        if (root !== null && deps.store) {
          const persisted = deps.store.read(poolKey, root);
          if (persisted && persisted.length > 0) {
            deps.onDecision?.(`leaf-cache STORE-HIT pool=${poolKey} root=${String(root).slice(0, 12)} n=${persisted.length}`);
            settle(poolKey, { at: now(), root, list: persisted, set: new Set(persisted) }, inFlight);
            return persisted;
          }
        }
        deps.onDecision?.(
          `leaf-cache FETCH pool=${poolKey} root=${String(root).slice(0, 12)}`
          + ` had=${cur === undefined ? 'no-entry' : `n=${cur.list.length} root=${String(cur.root).slice(0, 12)}`}`,
        );
        const raw = await source.getLeaves();
        const list = raw.map(deps.mapLeaf);
        if (settle(poolKey, { at: now(), root, list, set: new Set(list) }, inFlight) && root !== null) {
          deps.store?.write(poolKey, root, list);
        }
        return list;
      } catch (err) {
        // Clear the marker so the next caller retries instead of awaiting a
        // promise that already rejected.
        settle(poolKey, {}, inFlight);
        throw err;
      }
    });

    entries.set(poolKey, {
      at: entry?.at ?? 0,
      root: entry?.root ?? null,
      list: entry?.list ?? [],
      set: entry?.set ?? new Set<string>(),
      inFlight,
    });
    return inFlight;
  }

  return {
    /**
     * The pool's leaves in served order, fetched only when the root says the set
     * changed. `poolKey` identifies the pool (e.g. "chainId:entrypoint") and must
     * NOT be derived from the provider instance, which is short-lived. On a
     * chain an owner refreshes, a pure read of what it holds.
     */
    leaves(source: LeafSource, chainId: number, poolKey: string): Promise<readonly string[]> {
      if (deps.owns?.(chainId)) return readOwned(chainId, poolKey);
      return load(source, chainId, poolKey, false);
    },

    /** SDK root reads share the same grid-owned snapshot as its leaves. */
    async root(source: LeafSource, chainId: number, poolKey: string): Promise<string> {
      await this.leaves(source, chainId, poolKey);
      const root = entries.get(poolKey)?.root;
      if (root == null) throw new Error('association set root not loaded yet');
      return root;
    },

    /**
     * The owner's refresh: a fresh root probe, and the leaves only when that
     * root is not the one held (memory, then the durable store). The only path
     * that sends a request on an owned chain.
     */
    async refresh(source: LeafSource, chainId: number, poolKey: string): Promise<{ root: string | null; size: number }> {
      const owner = ownerOf(chainId);
      if (owner.poolKey !== poolKey) {
        owner.poolKey = poolKey;
        owner.held = false;
      }
      owner.attempted = true;
      try {
        const list = await load(source, chainId, poolKey, true);
        owner.held = true;
        owner.lastError = undefined;
        return { root: entries.get(poolKey)?.root ?? null, size: list.length };
      } catch (error) {
        owner.lastError = error;
        throw error;
      } finally {
        for (const wake of [...owner.waiters]) wake();
      }
    },

    /** The same cached fetch, as a membership set for label classification. */
    async approved(source: LeafSource, chainId: number, poolKey: string): Promise<Set<string>> {
      await this.leaves(source, chainId, poolKey);
      return entries.get(poolKey)?.set ?? new Set<string>();
    },

    // A rejected snapshot must not survive a fresh tab or explicit user retry.
    // Invalidation itself performs no ASP/RPC request or automatic retry.
    async verify<T>(chainId: number, poolKey: string, verify: () => Promise<T>): Promise<T> {
      try { return await verify(); } catch (error) {
        if (error instanceof Error && error.message.includes('ASP leaves root mismatch:')) invalidate(chainId, poolKey);
        throw error;
      }
    },

    invalidate,

    /** Test/ops seam: forget a pool's cached set. */
    reset(poolKey: string): void {
      entries.delete(poolKey);
    },

    /** Test/ops seam: forget a chain's root probe. */
    resetRoot(chainId: number): void {
      rootProbes.delete(chainId);
      owners.delete(chainId);
    },
  };
}
