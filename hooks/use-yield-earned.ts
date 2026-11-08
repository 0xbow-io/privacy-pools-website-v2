/**
 * Yield earned per share position, on every EVM chain with a yield share.
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
import type { Address, Hex } from '@privacy-pools-v2/sdk';
import { loadStoredAccountExport } from '@/components/sdk-provider';
import { getChainConfig, supportedChainIds } from '@/config/chains';
import { getConfiguredYieldDeployments } from '@/config/yield';
import type { PoolSession, PoolSessionYield, Secret } from '@/services/sdk-types';
import { FEED_SHARE_RATES } from '@/services/share-rate-feed';
import { shareRateKey, type ShareRate } from '@/services/share-rates';
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
  yieldEarnedNotesForShare,
  type ChainTaggedSnapshot,
  type SnapshotEventsReducer,
  type StoredYieldNote,
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
      if (x.earnedTotal !== y.earnedTotal || x.maxUnderstatement !== y.maxUnderstatement || x.assetDecimals !== y.assetDecimals || x.heldShares !== y.heldShares) return false;
    } else if (x.status !== 'ok' && y.status !== 'ok' && x.reason !== y.reason) {
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
  /** Identity the per-chain account exports are stored under (session address first). */
  identity?: string | null;
  /** The session's keys: the nullifying key matches stored notes of other chains to their spends. */
  keystoreManager?: { getPrivateNullifyingKey: () => Secret } | null;
}): YieldEarnedByShare {
  const { session, chainId } = params;
  // Pinned to the session it was computed for, so a new session reads empty
  // on its first render instead of showing the previous one's figures.
  const [state, setState] = useState<{ session: PoolSession | null; chainId: number | null; results: YieldEarnedByShare }>(
    { session: null, chainId: null, results: EMPTY_YIELD_EARNED },
  );

  const snapshotRef = useRef(params.snapshot);
  const identityRef = useRef(params.identity);
  const keystoreRef = useRef(params.keystoreManager);
  useEffect(() => {
    snapshotRef.current = params.snapshot;
    identityRef.current = params.identity;
    keystoreRef.current = params.keystoreManager;
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
    // Every OTHER EVM chain with a configured yield share. The session's
    // namespaces only cover its own chain, so a share held elsewhere (BSC
    // ppUSDT while the session is on mainnet) never got a figure and its row,
    // and with it the tile, stayed "—" (prod 2026-10-21). These go through the
    // SDK's pure compute over inputs already held: the chain's STORED notes,
    // the grid's feeds, and the share rate the grid already reads
    // (`exchangeRate()` is `convertToAssets(10 ** decimals)`, the same figure
    // as `assetsPerShare`). Nothing is fetched here.
    const otherChains = supportedChainIds.filter(
      (cid) => cid !== chainId && getChainConfig(cid)?.chainType === 'evm' && getConfiguredYieldDeployments(cid).length > 0,
    );
    // A session chain with no yield share (Citrea, Robinhood) still values the
    // shares held on the chains that have one.
    if (namespaces.length === 0 && otherChains.length === 0) return undefined;

    let cancelled = false;
    let running = false;
    // A tick asked for while one runs (a snapshot landing mid-compute) reruns
    // after it, instead of being dropped until the next 60s interval.
    let rerun = false;

    // Every share of `cid` "—" with one reason. Local state only, no request:
    // an input that stopped being ready must not leave the last figures on
    // screen as if they were current.
    const markUnavailable = (next: Map<string, YieldEarnedEntry>, shares: readonly string[], cid: number, reason: string) => {
      for (const share of shares) next.set(yieldEarnedKey(cid, share), { status: 'unavailable', reason });
    };
    // An input not here YET: the row shows a shimmer, never a "0" and never
    // the dash, which says no figure is coming (QA of #67: "0 USDC" while loading).
    const markLoading = (next: Map<string, YieldEarnedEntry>, shares: readonly string[], cid: number, reason: string) => {
      for (const share of shares) next.set(yieldEarnedKey(cid, share), { status: 'loading', reason });
    };
    const sessionShares = namespaces.map((ns) => ns.deployment.ppUSDC);

    // The session chain, through each namespace's compute. Fails on its own:
    // another chain's figures are unaffected.
    const computeSessionChain = async (
      next: Map<string, YieldEarnedEntry>,
      snapshot: (ChainTaggedSnapshot & { loadedChainIds?: readonly number[] }) | undefined,
    ) => {
      if (namespaces.length === 0) return;
      try {
        // Not loaded yet, or this chain's part of it failed: without its spends
        // a note that left would be valued as still held. The first is a wait,
        // the second is no figure (the snapshot waits for every chain, so a
        // chain missing from a loaded one failed).
        if (!snapshot) {
          markLoading(next, sessionShares, chainId, 'snapshot-not-ready');
          return;
        }
        if (snapshot.loadedChainIds && !snapshot.loadedChainIds.includes(chainId)) {
          markUnavailable(next, sessionShares, chainId, 'snapshot-chain-failed');
          return;
        }
        const depositsFeed = feedValue(feedData(
          publicFeeds.read<YieldFeedResult<YieldDepositsResponse>>(feedYieldDeposits(chainId)),
        ));
        if (depositsFeed === undefined) {
          markLoading(next, sessionShares, chainId, 'deposits-feed-loading');
          return;
        }

        const { yieldEarnedEventsFromSnapshot } = await import('@/services/sdk-runtime');
        const events = yieldEarnedEventsForChain(
          snapshot,
          chainId,
          yieldEarnedEventsFromSnapshot as unknown as SnapshotEventsReducer,
        );

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
              ? { status: 'loading', reason: 'rate-history-loading' }
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
      } catch {
        // A reducer or import that throws must not leave the last figures on
        // screen as if current (review of cddbf592).
        markUnavailable(next, sessionShares, chainId, 'compute-failed');
      }
    };

    const computeOtherChains = async (
      next: Map<string, YieldEarnedEntry>,
      snapshot: (ChainTaggedSnapshot & { loadedChainIds?: readonly number[] }) | undefined,
    ) => {
      const sharesOf = (cid: number) => getConfiguredYieldDeployments(cid).map((d) => d.ppUSDC);
      const identity = identityRef.current;
      const keystore = keystoreRef.current;
      if (!snapshot || !identity || !keystore) {
        // The snapshot, or the keys the stored notes are matched with, not here yet.
        for (const cid of otherChains) markLoading(next, sharesOf(cid), cid, 'snapshot-not-ready');
        return;
      }
      let sdk: typeof import('@/services/sdk-runtime');
      let hash: (commitment: Hex) => Hex;
      try {
        sdk = await import('@/services/sdk-runtime');
        const hashService = await sdk.createHashService();
        const nullifyingKey = keystore.getPrivateNullifyingKey();
        hash = (c) => String(hashService.hash([nullifyingKey, c])) as Hex;
      } catch {
        for (const cid of otherChains) markUnavailable(next, sharesOf(cid), cid, 'compute-failed');
        return;
      }
      const rates = feedData(publicFeeds.read<Record<string, ShareRate>>(FEED_SHARE_RATES));
      for (const cid of otherChains) {
        const shares = getConfiguredYieldDeployments(cid);
        try {
          if (snapshot.loadedChainIds && !snapshot.loadedChainIds.includes(cid)) {
            markUnavailable(next, sharesOf(cid), cid, 'snapshot-chain-failed');
            continue;
          }
          const depositsFeed = feedValue(feedData(
            publicFeeds.read<YieldFeedResult<YieldDepositsResponse>>(feedYieldDeposits(cid)),
          ));
          if (depositsFeed === undefined) {
            markLoading(next, sharesOf(cid), cid, 'deposits-feed-loading');
            continue;
          }
          const notes = (loadStoredAccountExport(identity, cid)?.notes ?? []) as unknown as StoredYieldNote[];
          const events = yieldEarnedEventsForChain(
            snapshot,
            cid,
            sdk.yieldEarnedEventsFromSnapshot as unknown as SnapshotEventsReducer,
          );
          for (const d of shares) {
            const key = yieldEarnedKey(cid, d.ppUSDC);
            const rateFeed = feedValue(feedData(
              publicFeeds.read<YieldFeedResult<PpUsdcRateHistoryResponse>>(feedYieldRateHistory(cid, d.ppUSDC)),
            ));
            const rate = rates?.[shareRateKey(cid, d.ppUSDC)];
            if (rateFeed === undefined) { next.set(key, { status: 'loading', reason: 'rate-history-loading' }); continue; }
            // No rates map yet is a wait. A map without this share is no figure.
            if (!rates) { next.set(key, { status: 'loading', reason: 'exchange-rate-loading' }); continue; }
            if (!rate) { next.set(key, { status: 'unavailable', reason: 'exchange-rate-read-failed' }); continue; }
            const rateSeries = toYieldRateSeries(rateFeed, d.ppUSDC);
            try {
              const result = sdk.computeYieldEarned({
                share: d.ppUSDC.toLowerCase() as Address,
                shareDecimals: d.ppUSDCDecimals,
                notes: yieldEarnedNotesForShare(notes, d.ppUSDC, hash, sdk.noteTimestamp),
                depositFacts: toYieldDepositFacts(depositsFeed, d.ppUSDC),
                rateSeries,
                events,
                exchangeRateNow: rate.assetsPerShare,
                now: Math.floor(Date.now() / 1000),
              });
              next.set(key, toYieldEarnedEntry(result, rateSeries?.assetDecimals ?? 0));
            } catch {
              next.set(key, { status: 'unavailable', reason: 'compute-failed' });
            }
          }
        } catch {
          // One chain's failure blanks that chain only.
          markUnavailable(next, sharesOf(cid), cid, 'compute-failed');
        }
      }
    };

    const tick = async () => {
      if (cancelled) return;
      if (running) { rerun = true; return; }
      running = true;
      try {
        const snapshot = snapshotRef.current;
        const next = new Map<string, YieldEarnedEntry>();
        await computeSessionChain(next, snapshot);
        await computeOtherChains(next, snapshot);
        // A share configured on the session chain that no namespace computes
        // would otherwise have no entry, and no entry reads as "still loading"
        // forever. It gets no figure, said once.
        for (const d of getConfiguredYieldDeployments(chainId)) {
          const key = yieldEarnedKey(chainId, d.ppUSDC);
          if (!next.has(key)) next.set(key, { status: 'unavailable', reason: 'no-earned-namespace' });
        }
        if (!cancelled) {
          setState((prev) => (prev.session === session && prev.chainId === chainId && sameEntries(prev.results, next)
            ? prev
            : { session, chainId, results: next }));
        }
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
      ...(namespaces.length > 0 ? [feedYieldDeposits(chainId)] : []),
      ...namespaces.map((ns) => feedYieldRateHistory(chainId, ns.deployment.ppUSDC)),
      ...otherChains.flatMap((cid) => [
        feedYieldDeposits(cid),
        ...getConfiguredYieldDeployments(cid).map((d) => feedYieldRateHistory(cid, d.ppUSDC)),
      ]),
      ...(otherChains.length > 0 ? [FEED_SHARE_RATES] : []),
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
