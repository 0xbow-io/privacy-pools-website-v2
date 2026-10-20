/**
 * This account's points across every EVM chain, computed locally by the SDK.
 *
 * WHAT GOES ON THE WIRE. Nothing from here. Parameters come from the points
 * feed's cache (services/points-feed.ts, on the app-wide grid, the same for
 * every client); notes from the live session (its chain) and the per-chain
 * account exports already in storage (the others); spend times from the
 * session sync's bulk index. The only clock is a one-minute tick so the
 * estimate since the last epoch moves on screen.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useAccount } from 'wagmi';
import type { IHashService, PointsEpochParams } from '@privacy-pools-v2/sdk';

import { loadStoredAccountExport, loadStoredNoteSpendTimes, useSdkContext } from '@/components/sdk-provider';
import { getChainConfig, supportedChainIds } from '@/config/chains';
import { POINTS_ENABLED } from '@/config/points';
import { getTokenMetadata } from '@/config/tokens';
import { useNotes } from '@/hooks/use-notes';
import { useSessionChainId } from '@/hooks/use-session-chain-id';
import { noteSpendTime, restoreNoteSpendTimes, subscribeNoteSpendTimes } from '@/services/note-spend-times';
import { feedData, publicFeeds } from '@/services/public-feed-scheduler';
import { feedPointsEpochs, type PointsFeedValue } from '@/services/points-feed';
import {
  aggregatePoints,
  toPointsNoteInputs,
  type ChainPoints,
  type PointsNoteLike,
  type PointsTotals,
} from '@/services/points';
import type { YieldFeedResult } from '@/services/yield-feeds';

export const POINTS_TICK_MS = 60_000;

export type PointsState =
  | { status: 'disabled' }
  | { status: 'loading' }
  | { status: 'no-epochs' }
  | { status: 'error' }
  | {
    status: 'ready';
    totals: PointsTotals;
    computedAt: number;
    /** Chains whose points feed failed before it ever loaded: left out of the totals. */
    unavailableChainIds: number[];
  };

let externalVersion = 0;
function subscribeInputs(onChange: () => void): () => void {
  const bump = () => {
    externalVersion += 1;
    onChange();
  };
  const offs = [subscribeNoteSpendTimes(bump)];
  for (const cid of supportedChainIds) offs.push(publicFeeds.subscribe(feedPointsEpochs(cid), bump));
  return () => {
    for (const off of offs) off();
  };
}
const readExternalVersion = () => externalVersion;

// Poseidon, to recompute each epoch's rate tree root: built once per page, not
// per tick. A failed build is dropped so the next tick can retry it.
let hashServicePromise: Promise<IHashService> | null = null;
function pointsHashService(): Promise<IHashService> {
  if (!hashServicePromise) {
    hashServicePromise = import('@/services/sdk-runtime')
      .then(({ createHashService }) => createHashService())
      .catch((error: unknown) => {
        hashServicePromise = null;
        throw error;
      });
  }
  return hashServicePromise;
}

// Published epoch parameters per feed value. The feed hands out a new value
// object only when it refetches, so the rate-root recomputation runs once per
// fetch rather than on every one-minute tick.
const publishedParamsCache = new WeakMap<PointsFeedValue, PointsEpochParams[]>();

// "chainId:account" whose persisted spend times this page has restored.
const restoredSpendTimes = new Set<string>();

export function usePoints(): PointsState {
  const { sessionAddress, notesRevision } = useSdkContext();
  const { address: walletAddress } = useAccount();
  const sessionChainId = useSessionChainId();
  const { notes: sessionNotes } = useNotes();
  const account = sessionAddress ?? walletAddress ?? null;
  const inputsVersion = useSyncExternalStore(subscribeInputs, readExternalVersion, readExternalVersion);

  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!POINTS_ENABLED) return undefined;
    const interval = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), POINTS_TICK_MS);
    return () => clearInterval(interval);
  }, []);

  const notesByChain = useMemo(() => {
    const byChain = new Map<number, PointsNoteLike[]>();
    if (!POINTS_ENABLED || !account) return byChain;
    for (const cid of supportedChainIds) {
      if (getChainConfig(cid)?.chainType !== 'evm') continue;
      const notes = cid === sessionChainId
        ? (sessionNotes as unknown as PointsNoteLike[])
        : ((loadStoredAccountExport(account, cid)?.notes ?? []) as unknown as PointsNoteLike[]);
      if (notes.length > 0) byChain.set(cid, notes);
    }
    return byChain;
  }, [account, sessionChainId, sessionNotes, notesRevision]);

  // Keyed by account, so a wallet switch shows loading rather than the previous
  // account's totals until this account's are computed.
  const [result, setResult] = useState<{ account: string; state: PointsState } | null>(null);

  useEffect(() => {
    if (!POINTS_ENABLED || !account) return undefined;
    // A reloaded tab is locked until sign-in and cannot derive spend times, so
    // restore what an earlier pass persisted beside each chain's notes.
    for (const cid of notesByChain.keys()) {
      const restoreKey = `${cid}:${account.toLowerCase()}`;
      if (restoredSpendTimes.has(restoreKey)) continue;
      restoredSpendTimes.add(restoreKey);
      restoreNoteSpendTimes(cid, account, loadStoredNoteSpendTimes(account, cid));
    }
    let cancelled = false;
    const publish = (next: PointsState) => {
      if (!cancelled) setResult({ account, state: next });
    };
    void (async () => {
      try {
        if (notesByChain.size === 0) {
          publish({ status: 'ready', totals: aggregatePoints([]), computedAt: nowSeconds, unavailableChainIds: [] });
          return;
        }
        const feeds = new Map<number, YieldFeedResult<PointsFeedValue>>();
        const unavailableChainIds: number[] = [];
        let stillLoading = false;
        for (const cid of notesByChain.keys()) {
          const feedState = publicFeeds.read<YieldFeedResult<PointsFeedValue>>(feedPointsEpochs(cid));
          const data = feedData(feedState);
          if (data !== undefined) feeds.set(cid, data);
          // A feed that failed before it ever loaded is left out and reported,
          // so one failing chain neither hides the others nor loads forever.
          else if (feedState.status === 'error') unavailableChainIds.push(cid);
          else stillLoading = true;
        }
        if (stillLoading) {
          publish({ status: 'loading' });
          return;
        }

        const now = BigInt(nowSeconds);
        const chains: ChainPoints[] = [];
        for (const [chainId, notes] of notesByChain) {
          const feed = feeds.get(chainId);
          if (!feed || feed.status !== 'ok' || feed.value.epochs.length === 0) continue;
          const { computePoints, epochParamsFromRateLeaves, liveEpochParams } = await import('@/services/sdk-runtime');
          let published = publishedParamsCache.get(feed.value);
          if (!published) {
            const hashService = await pointsHashService();
            published = [];
            let previousSnapshot: bigint | null = null;
            for (const { epoch, rateLeaves } of feed.value.epochs) {
              // Throws unless the leaves recompute to the epoch's rateRoot.
              const params = epochParamsFromRateLeaves(epoch, rateLeaves, previousSnapshot, hashService);
              published.push(params);
              previousSnapshot = params.snapshotTime;
            }
            publishedParamsCache.set(feed.value, published);
          }
          const inputs = toPointsNoteInputs(notes, (commitment) => noteSpendTime(chainId, account, commitment));
          // The stretch since the last snapshot, priced with that epoch's parameters:
          // an estimate until the next epoch publishes its own.
          const latest = published[published.length - 1];
          const summary = computePoints(inputs, published, latest ? liveEpochParams(latest, now) : null);
          const symbols = new Map<string, string>();
          for (const input of inputs) {
            const tokenId = input.tokenId.toLowerCase();
            if (!symbols.has(tokenId)) symbols.set(tokenId, getTokenMetadata(tokenId, chainId).symbol);
          }
          chains.push({
            chainId,
            summary,
            symbols,
            pendingCommitments: new Set(inputs.filter((n) => n.aspStatus === 'pending').map((n) => n.commitment)),
            latestEpoch: published[published.length - 1]?.epochNumber ?? null,
          });
        }
        if (chains.length === 0) {
          publish(unavailableChainIds.length > 0 ? { status: 'error' } : { status: 'no-epochs' });
          return;
        }
        publish({ status: 'ready', totals: aggregatePoints(chains), computedAt: nowSeconds, unavailableChainIds });
      } catch (error) {
        if (__DEV__) console.debug('[points] compute failed', error instanceof Error ? error.message : String(error));
        publish({ status: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, notesByChain, nowSeconds, inputsVersion]);

  if (!POINTS_ENABLED) return { status: 'disabled' };
  if (!account || result?.account !== account) return { status: 'loading' };
  return result.state;
}
