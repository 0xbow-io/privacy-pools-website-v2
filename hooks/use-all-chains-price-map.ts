import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { supportedEvmChainIds } from '@/config/chains';
import { EMPTY_PRICE_MAP, mergePriceMaps, type PriceMapEntry } from '@/services/price-map-merge';
import { feedPriceMap } from '@/services/public-feeds';
import { PRICE_FEED_SETTLE_DEADLINE_MS, priceFeedsSettled } from '@/services/price-feed-settled';
import { feedData, publicFeeds } from '@/services/public-feed-scheduler';

/**
 * Every supported chain's prices, merged, read straight off the public-feed
 * grid. Like `usePublicFeed`, it has no refetch and no enabled: a component
 * cannot cause a request, which is the whole point (see
 * services/price-map-merge.ts for what this replaced).
 *
 * `activeChainId` only decides who wins a symbol collision; it never changes
 * which feeds are read, so switching chains cannot start one either.
 */
export function useAllChainsPriceMap(activeChainId?: number): Readonly<Record<string, number>> {
  // One subscription set for the life of the component. supportedEvmChainIds is
  // a per-environment constant; the debug ?env= toggle can change it, but the
  // scheduler latches its registrations on first start, so the keys a mounted
  // tree reads stay put.
  const keys = useMemo(() => supportedEvmChainIds.map((chainId) => ({ chainId, key: feedPriceMap(chainId) })), []);

  const subscribe = useCallback((onChange: () => void) => {
    const unsubscribes = keys.map(({ key }) => publicFeeds.subscribe(key, onChange));
    return () => { for (const off of unsubscribes) off(); };
  }, [keys]);

  // useSyncExternalStore calls getSnapshot on every render and compares by
  // identity, so the merge has to be memoized against the feed states it came
  // from — a fresh object each call is an infinite loop.
  const cache = useRef<{ states: readonly unknown[]; active?: number; merged: Readonly<Record<string, number>> } | null>(null);

  const getSnapshot = useCallback(() => {
    const states = keys.map(({ key }) => publicFeeds.read<Record<string, number>>(key));
    const previous = cache.current;
    if (
      previous
      && previous.active === activeChainId
      && previous.states.length === states.length
      && previous.states.every((state, i) => state === states[i])
    ) return previous.merged;

    const entries: PriceMapEntry[] = keys.map(({ chainId }, i) => ({
      chainId,
      // Last good data survives an errored refresh (the scheduler keeps it), so
      // a feed that just failed still contributes what it had.
      prices: feedData(states[i]) ?? null,
    }));
    const merged = mergePriceMaps(entries, activeChainId);
    cache.current = { states, active: activeChainId, merged };
    return merged;
  }, [keys, activeChainId]);

  // Hydration has no serialized feed cache, same as usePublicFeed.
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_PRICE_MAP);
}

/**
 * Whether the price grid has ANSWERED yet — the replacement for a query's
 * `isPending` on anything gated on a price (see services/price-feed-settled.ts
 * for the incident that made this necessary).
 *
 * Like the map above it only READS the scheduler, so asking "are we still
 * loading?" cannot itself put a request on the wire. The deadline keeps the
 * wait bounded even when the scheduler was never started in this tree, which is
 * the case `isPending` used to cover for free.
 */
export function usePriceFeedsSettled(): boolean {
  const keys = useMemo(() => supportedEvmChainIds.map((chainId) => feedPriceMap(chainId)), []);

  const subscribe = useCallback((onChange: () => void) => {
    const unsubscribes = keys.map((key) => publicFeeds.subscribe(key, onChange));
    return () => { for (const off of unsubscribes) off(); };
  }, [keys]);

  const getSnapshot = useCallback(
    () => priceFeedsSettled(keys.map((key) => publicFeeds.read(key).status)),
    [keys],
  );

  // Server/hydration: report settled rather than block a first paint on a
  // scheduler that does not exist there.
  const answered = useSyncExternalStore(subscribe, getSnapshot, () => true);

  // The deadline. A tree that never starts the scheduler would otherwise wait
  // forever, which is the exact failure this whole module exists to prevent.
  const [deadlinePassed, setDeadlinePassed] = useState(false);
  useEffect(() => {
    if (answered) return;
    const timer = setTimeout(() => setDeadlinePassed(true), PRICE_FEED_SETTLE_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [answered]);

  return answered || deadlinePassed;
}
