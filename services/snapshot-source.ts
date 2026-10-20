/**
 * The single place the ASP event-snapshot payload is fetched, and the pool's
 * state and keystore leaves with it.
 *
 * Two consumers used to fetch it independently - the note index and the
 * transfer-classification query, the latter on a 60s poll - so a cold load
 * pulled it 12 times for ~8.8MB. They share one copy per pool now
 * (services/snapshot-cache.ts), and only the public feed grid refreshes it
 * (services/public-feeds.ts): once at page load in full, then a delta on each
 * wall-clock instant. Reading it never sends a request, so no reader, and no
 * user action behind a reader, decides when the ASP hears from this client.
 *
 * The leaves follow the same rule. The SDK rebuilds the state and keystore
 * trees from them while it prepares every spend proof, and the leaf fast path
 * used to top its memo up from the ASP right then, so a withdrawal being
 * proved could put a request on the wire at that moment. The proof reads the
 * held copy and sweeps the rest of the chain over RPC (services/sdk-setup.ts).
 *
 * ONE instance per payload per app, hung off globalThis. The web bundle can
 * evaluate a module more than once, and a second instance brings its own empty
 * map - that is exactly how the association-set cache silently kept
 * refetching until its own decision log gave it away.
 */
import apiClient from '@/services/api-client';
import { resolveConfiguredEntrypoint } from '@/services/pool-entrypoint';
import { createSnapshotStore } from '@/services/snapshot-cache';
import { recordSnapshotNoteCiphertexts } from '@/services/note-ciphertexts';
import { snapshotCursor } from '@/services/asp-event-snapshot';
import { mergeSnapshotDelta, snapshotDeltaSince } from '@/services/snapshot-delta';
import { blockTimeMs } from '@/services/chain-block-time';
import { getChainConfig } from '@/config/chains';
import { publicFeeds } from '@/services/public-feed-scheduler';

/**
 * The sections parseEventSnapshot reads (see onchain-note-index.ts), plus the
 * pool's Note ciphertexts: they decide which deposits this wallet paid for are
 * this account's (services/deposit-ownership.ts, signal 3), and discovery reads
 * its Note events from them instead of asking the ASP (services/sdk-setup.ts).
 */
const INCLUDE = ['deposits', 'transacts', 'ragequits', 'notes'] as const;

/** The two trees a spend proof is built against. One request, one watermark. */
const LEAF_INCLUDE = ['leaves', 'keystoreLeaves'] as const;

/**
 * Grid period of the snapshot feed. Each instant is a delta of a few KB, and
 * nothing that must be current waits on it: the note index and the SDK scan the
 * chain above the snapshot's own block, and our own operations show from the
 * local ledger.
 */
export const EVENT_SNAPSHOT_INTERVAL_MS = 2 * 60_000;

/** Same cadence: the proof sweeps every block above the held copy over RPC. */
export const POOL_LEAVES_INTERVAL_MS = 2 * 60_000;

export function feedEventSnapshot(chainId: number): string {
  return `event-snapshot:${chainId}`;
}

export function feedPoolLeaves(chainId: number): string {
  return `pool-leaves:${chainId}`;
}

type SnapshotPayload = Awaited<ReturnType<typeof apiClient.getEventSnapshotPayload>>;
type Section = NonNullable<Parameters<typeof apiClient.getEventSnapshotPayload>[1]>[number];

type GridKey = { key: Promise<string>; lookupFailed: boolean };

type Shared = {
  store: ReturnType<typeof createSnapshotStore<SnapshotPayload>>;
  /**
   * The pool key the grid refreshes for each chain, from its first refresh on.
   * Only an answered entrypoint lookup is kept: a failed one fails that refresh
   * like any other, and the next refresh looks the pool up again.
   */
  gridKeys: Map<number, GridKey>;
  /** Readers that arrived before the grid's first refresh of their chain. */
  keyWaiters: Map<number, Array<() => void>>;
};

function poolKeyOf(chainId: number, entrypoint: string | undefined): string {
  return `${chainId}:${(entrypoint ?? '').toLowerCase()}`;
}

function splitPoolKey(poolKey: string): [number, string | undefined] {
  const idx = poolKey.indexOf(':');
  const chainId = Number(poolKey.slice(0, idx));
  const entrypoint = poolKey.slice(idx + 1);
  return [chainId, entrypoint === '' ? undefined : entrypoint];
}

/**
 * One payload the feed grid owns: refreshed by the grid's feed and nothing
 * else, read by everyone else without a request.
 */
function gridOwnedPayload(opts: {
  flag: string;
  label: string;
  include: readonly Section[];
  feedKey: (chainId: number) => string;
  onPayload?: (chainId: number, payload: SnapshotPayload) => void;
}) {
  const shared = ((): Shared => {
    const existing = (globalThis as Record<string, unknown>)[opts.flag];
    if (existing) return existing as Shared;
    const store = createSnapshotStore<SnapshotPayload>({
      fetchFull: async (poolKey) => {
        const [chainId, entrypoint] = splitPoolKey(poolKey);
        return apiClient.getEventSnapshotPayload(chainId, opts.include, undefined, entrypoint);
      },
      // Within a page the payload is topped up, never downloaded whole again
      // (services/snapshot-delta.ts). Anything that cannot be joined safely
      // falls back to the full download.
      fetchUpdate: async (poolKey, held) => {
        const [chainId, entrypoint] = splitPoolKey(poolKey);
        const full = () => apiClient.getEventSnapshotPayload(chainId, opts.include, undefined, entrypoint);
        const coveredTo = snapshotCursor(held, opts.include);
        if (coveredTo === null) return full();
        const deploymentBlock = getChainConfig(chainId)?.contracts?.fromBlock ?? 0n;
        const since = snapshotDeltaSince(coveredTo, deploymentBlock, blockTimeMs(chainId));
        const delta = await apiClient.getEventSnapshotPayload(chainId, opts.include, since, entrypoint);
        const merged = snapshotCursor(delta, opts.include) === null
          ? null
          : mergeSnapshotDelta(held as unknown as Record<string, unknown>, delta as unknown as Record<string, unknown>, since, opts.include);
        return merged ? (merged as unknown as SnapshotPayload) : full();
      },
      onDecision: (line) => { try { console.log(`[perf] · ${opts.label} ${line}`); } catch { /* ignore */ } },
    });
    const created: Shared = { store, gridKeys: new Map(), keyWaiters: new Map() };
    (globalThis as Record<string, unknown>)[opts.flag] = created;
    return created;
  })();

  const gridOwns = (chainId: number) =>
    publicFeeds.isRunning() && publicFeeds.registered().includes(opts.feedKey(chainId));

  const record = (chainId: number, payload: SnapshotPayload): SnapshotPayload => {
    try {
      opts.onPayload?.(chainId, payload);
    } catch {
      // A cache path never fails the read.
    }
    return payload;
  };

  /** The grid's key for this chain, waiting for its first refresh when it has not started yet. */
  async function gridKeyFor(chainId: number): Promise<string> {
    const known = shared.gridKeys.get(chainId);
    if (known) return known.key;
    await new Promise<void>((resolve) => {
      const waiters = shared.keyWaiters.get(chainId) ?? [];
      waiters.push(resolve);
      shared.keyWaiters.set(chainId, waiters);
    });
    return shared.gridKeys.get(chainId)!.key;
  }

  return {
    async refresh(chainId: number): Promise<SnapshotPayload> {
      let gridKey = shared.gridKeys.get(chainId);
      if (!gridKey || gridKey.lookupFailed) {
        // A failed lookup names no pool. The chain-only request is right only on
        // a single-pool chain, and pinning it would keep every later refresh
        // unscoped and refuse the SDK's own pool until reload.
        const entry: GridKey = {
          key: resolveConfiguredEntrypoint(chainId).then((entrypoint) => poolKeyOf(chainId, entrypoint)),
          lookupFailed: false,
        };
        entry.key.catch(() => { entry.lookupFailed = true; });
        gridKey = entry;
        shared.gridKeys.set(chainId, entry);
        const waiters = shared.keyWaiters.get(chainId) ?? [];
        shared.keyWaiters.delete(chainId);
        for (const wake of waiters) wake();
      }
      return record(chainId, await shared.store.refresh(await gridKey.key));
    },

    async load(chainId: number, readOpts?: { entrypoint?: string }): Promise<SnapshotPayload> {
      if (gridOwns(chainId)) {
        // The grid starts with the app and bootstraps every feed at once, so a
        // reader that arrives first waits only for that (or, in a tab loaded in
        // the background, for the tab to become active).
        const key = await gridKeyFor(chainId);
        if (readOpts?.entrypoint && poolKeyOf(chainId, readOpts.entrypoint) !== key) {
          throw new Error(`${opts.label} for ${readOpts.entrypoint} is not the pool the feed grid refreshes on chain ${chainId}`);
        }
        return record(chainId, await shared.store.read(key, { mayBootstrap: false }));
      }
      // Nothing owns the chain (tests, a build without the grid): the first read
      // is the page's one download, and the copy is not refreshed after it.
      const entrypoint = readOpts?.entrypoint ?? await resolveConfiguredEntrypoint(chainId).catch(() => undefined);
      return record(chainId, await shared.store.read(poolKeyOf(chainId, entrypoint), { mayBootstrap: true }));
    },

    async heldAt(chainId: number): Promise<number | undefined> {
      const gridKey = shared.gridKeys.get(chainId);
      if (!gridKey) return undefined;
      const key = await gridKey.key.catch(() => undefined);
      return key === undefined ? undefined : shared.store.heldAt(key);
    },

    reset(): void {
      shared.store.reset();
      shared.gridKeys.clear();
      shared.keyWaiters.clear();
    },
  };
}

const eventSnapshot = gridOwnedPayload({
  flag: '__ppv2SnapshotStore',
  label: 'event snapshot',
  include: INCLUDE,
  feedKey: feedEventSnapshot,
  onPayload: recordSnapshotNoteCiphertexts,
});

const poolLeaves = gridOwnedPayload({
  flag: '__ppv2PoolLeavesStore',
  label: 'pool leaves',
  include: LEAF_INCLUDE,
  feedKey: feedPoolLeaves,
});

/**
 * The grid's refresh of one chain's snapshot, and the only caller that may
 * send a snapshot request. Not for anything else to call.
 */
export async function refreshPoolEventSnapshot(chainId: number): Promise<SnapshotPayload> {
  return eventSnapshot.refresh(chainId);
}

/**
 * The chain's event snapshot as last refreshed. Never sends a request while the
 * grid owns the chain: a read before the first refresh waits for it, and a read
 * after a failed one gets that failure until the grid's next instant.
 *
 * `entrypoint` names the pool the caller expects (the SDK passes its own). A
 * pool other than the one the grid refreshes is refused rather than fetched:
 * the caller falls back to the chain, which is slower and asks the ASP nothing.
 */
export function loadPoolEventSnapshot(chainId: number, opts?: { entrypoint?: string }): Promise<SnapshotPayload> {
  return eventSnapshot.load(chainId, opts);
}

/**
 * When the refresh behind this chain's copy was requested, by this client's
 * clock, or undefined while nothing is held. For a caller that reasons from
 * absence.
 */
export function poolEventSnapshotHeldAt(chainId: number): Promise<number | undefined> {
  return eventSnapshot.heldAt(chainId);
}

export function resetPoolEventSnapshotCache(): void {
  eventSnapshot.reset();
}

/** The grid's refresh of one chain's state and keystore leaves. Not for anything else to call. */
export async function refreshPoolLeaves(chainId: number): Promise<SnapshotPayload> {
  return poolLeaves.refresh(chainId);
}

/**
 * The chain's state and keystore leaves as last refreshed, with the block they
 * cover through. Same contract as loadPoolEventSnapshot: never a request while
 * the grid owns the chain.
 */
export function loadPoolLeaves(chainId: number, opts?: { entrypoint?: string }): Promise<SnapshotPayload> {
  return poolLeaves.load(chainId, opts);
}

export function resetPoolLeavesCache(): void {
  poolLeaves.reset();
}
