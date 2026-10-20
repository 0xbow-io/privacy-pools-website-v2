/**
 * Yield earned per share position, for the session's chain.
 *
 * Mounted once, in PoolsProvider (app-wide), not by the portfolio: opening the
 * Portfolio page, expanding a row or picking a chain there cannot start, stop
 * or re-time anything here. It only reads.
 *
 * WHAT GOES ON THE WIRE. One thing: each yield namespace's `compute` reads the
 * share's no-argument `exchangeRate()`. It does that for EVERY share the
 * session configures, whether or not this wallet holds any, on a fixed
 * cadence from when the session is ready, and it does not pause while a
 * transaction is in flight. Everything else is already in memory:
 *   - rate history per share and the deposits feed: the public-feed grid's
 *     cache (`publicFeeds.read`, which cannot fetch);
 *   - pool events: the event snapshot PoolsProvider already polls.
 * A change of notes or of what the user is looking at does not trigger a
 * compute: inputs are read from a ref at the next tick. A grid feed landing
 * does, and so does the event snapshot changing, since it moves only on the
 * public-feed grid (PoolsProvider re-reads it when the grid publishes). Both
 * are timed by the grid, not by the user.
 */
import { useEffect, useRef, useState } from 'react';

import { feedData, publicFeeds } from '@/services/public-feed-scheduler';
import type { PpUsdcRateHistoryResponse, YieldDepositsResponse } from '@/services/api-types';
import type { PoolSession, PoolSessionYield } from '@/services/sdk-types';
import { feedYieldDeposits, feedYieldRateHistory } from '@/services/yield-feed-grid';
import type { YieldFeedResult } from '@/services/yield-feeds';
import {
  EMPTY_YIELD_EARNED,
  feedValue,
  toYieldDepositFacts,
  toYieldEarnedEntry,
  toYieldRateSeries,
  yieldEarnedEventsForChain,
  yieldEarnedKey,
  type ChainTaggedSnapshot,
  type SnapshotEventsReducer,
  type YieldEarnedByShare,
  type YieldEarnedEntry,
} from '@/services/yield-earned';

/** Same cadence as the share-rate reads (hooks/use-share-rates.ts). */
export const YIELD_EARNED_INTERVAL_MS = 60_000;

type EarnedNamespace = PoolSessionYield & {
  deployment: NonNullable<PoolSessionYield['deployment']>;
  earned: NonNullable<PoolSessionYield['earned']>;
};

/** Every yield namespace of the session that can compute earned. */
function earnedNamespaces(session: PoolSession): EarnedNamespace[] {
  const list = session.yields?.length ? session.yields : session.yield ? [session.yield] : [];
  return list.filter((ns): ns is EarnedNamespace => !!ns.earned && !!ns.deployment?.ppUSDC);
}

function sameEntries(a: YieldEarnedByShare, b: YieldEarnedByShare): boolean {
  if (a.size !== b.size) return false;
  for (const [key, x] of a) {
    const y = b.get(key);
    if (!y || x.status !== y.status) return false;
    if (x.status === 'ok' && y.status === 'ok') {
      if (x.earnedTotal !== y.earnedTotal || x.maxUnderstatement !== y.maxUnderstatement || x.assetDecimals !== y.assetDecimals) return false;
    } else if (x.status === 'unavailable' && y.status === 'unavailable' && x.reason !== y.reason) {
      return false;
    }
  }
  return true;
}

export function useYieldEarned(params: {
  session: PoolSession | null;
  /** The chain `session` was built for. */
  chainId: number | null;
  /** PoolsProvider's merged snapshot, chain-tagged; undefined until loaded. */
  snapshot: (ChainTaggedSnapshot & { loadedChainIds?: readonly number[] }) | undefined;
}): YieldEarnedByShare {
  const { session, chainId } = params;
  // Pinned to the session it was computed for, so a new session reads empty
  // on its first render instead of showing the previous one's figures.
  const [state, setState] = useState<{ session: PoolSession | null; chainId: number | null; results: YieldEarnedByShare }>(
    { session: null, chainId: null, results: EMPTY_YIELD_EARNED },
  );

  const snapshotRef = useRef(params.snapshot);
  useEffect(() => {
    snapshotRef.current = params.snapshot;
  });
  // The live tick of the current session effect, so a snapshot landing can run it.
  const tickRef = useRef<(() => void) | null>(null);
  // A snapshot that lands after the session was built used to wait for the next
  // 60s interval, the tile sitting on "—" meanwhile (QA 2026-10-12). The
  // snapshot moves on the public-feed grid (pools-provider re-reads it when
  // the grid publishes), so a compute timed by it is grid-timed, not UI-timed.
  useEffect(() => {
    tickRef.current?.();
  }, [params.snapshot]);

  useEffect(() => {
    if (!session || chainId == null) return undefined;
    const namespaces = earnedNamespaces(session);
    if (namespaces.length === 0) return undefined;

    let cancelled = false;
    let running = false;
    // A tick asked for while one runs (a snapshot landing mid-compute) reruns
    // after it, instead of being dropped until the next 60s interval.
    let rerun = false;

    // Every share "—" with one reason. Local state only, no request: an input
    // that stopped being ready must not leave the last figures on screen as if
    // they were current.
    const allUnavailable = (reason: string) => {
      if (cancelled) return;
      const next = new Map<string, YieldEarnedEntry>();
      for (const ns of namespaces) next.set(yieldEarnedKey(chainId, ns.deployment.ppUSDC), { status: 'unavailable', reason });
      setState((prev) => (prev.session === session && prev.chainId === chainId && sameEntries(prev.results, next)
        ? prev
        : { session, chainId, results: next }));
    };

    const tick = async () => {
      if (cancelled) return;
      if (running) { rerun = true; return; }
      running = true;
      try {
        const snapshot = snapshotRef.current;
        // Not loaded, or this chain's part of it failed: without its spends a
        // note that left would be valued as still held.
        if (!snapshot || (snapshot.loadedChainIds && !snapshot.loadedChainIds.includes(chainId))) {
          allUnavailable('snapshot-not-ready');
          return;
        }
        const depositsFeed = feedValue(feedData(
          publicFeeds.read<YieldFeedResult<YieldDepositsResponse>>(feedYieldDeposits(chainId)),
        ));
        if (depositsFeed === undefined) {
          allUnavailable('deposits-feed-loading');
          return;
        }

        const { yieldEarnedEventsFromSnapshot } = await import('@/services/sdk-runtime');
        const events = yieldEarnedEventsForChain(
          snapshot,
          chainId,
          yieldEarnedEventsFromSnapshot as unknown as SnapshotEventsReducer,
        );

        const next = new Map<string, YieldEarnedEntry>();
        for (const ns of namespaces) {
          const share = ns.deployment.ppUSDC;
          const rateFeed = feedValue(feedData(
            publicFeeds.read<YieldFeedResult<PpUsdcRateHistoryResponse>>(feedYieldRateHistory(chainId, share)),
          ));
          // Computed for every share, held or not, so which shares this client
          // reads the rate of says nothing about which it holds.
          const rateSeries = rateFeed === undefined ? null : toYieldRateSeries(rateFeed, share);
          const depositFacts = toYieldDepositFacts(depositsFeed, share);
          let entry: YieldEarnedEntry;
          try {
            const result = await ns.earned.compute({ depositFacts, rateSeries, events });
            entry = rateFeed === undefined
              ? { status: 'unavailable', reason: 'rate-history-loading' }
              : toYieldEarnedEntry(result, rateSeries?.assetDecimals ?? 0);
          } catch {
            entry = { status: 'unavailable', reason: 'exchange-rate-read-failed' };
          }
          if (__DEV__ && entry.status === 'unavailable') {
            // Reason only: never a commitment, a nullifier or an amount.
            console.debug(`[yield-earned] ${yieldEarnedKey(chainId, share)} unavailable: ${entry.reason}`);
          }
          next.set(yieldEarnedKey(chainId, share), entry);
        }
        if (!cancelled) {
          setState((prev) => (prev.session === session && prev.chainId === chainId && sameEntries(prev.results, next)
            ? prev
            : { session, chainId, results: next }));
        }
      } catch {
        // A reducer or import that throws must not leave the last figures on
        // screen as if current: every share falls back to "—" until a later
        // tick succeeds (review of cddbf592).
        allUnavailable('compute-failed');
      } finally {
        running = false;
        if (rerun && !cancelled) { rerun = false; void tick(); }
      }
    };

    tickRef.current = () => { void tick(); };
    void tick();
    const interval = setInterval(() => { void tick(); }, YIELD_EARNED_INTERVAL_MS);
    // A grid feed landing is grid-timed, so computing on it is too.
    const unsubscribe = [
      feedYieldDeposits(chainId),
      ...namespaces.map((ns) => feedYieldRateHistory(chainId, ns.deployment.ppUSDC)),
    ].map((key) => publicFeeds.subscribe(key, () => { void tick(); }));

    return () => {
      cancelled = true;
      tickRef.current = null;
      clearInterval(interval);
      for (const off of unsubscribe) off();
    };
  }, [session, chainId]);

  return state.session === session && state.chainId === chainId ? state.results : EMPTY_YIELD_EARNED;
}
