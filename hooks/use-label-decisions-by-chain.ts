import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';

import { supportedEvmChainIds } from '@/config/chains';
import { feedLabelDecisions, type LabelDecisions } from '@/services/label-decision-feed';
import { feedData, publicFeeds } from '@/services/public-feed-scheduler';

export type LabelDecisionSets = { rejected: ReadonlySet<string>; poiRequired: ReadonlySet<string> };

const EMPTY: ReadonlyMap<number, LabelDecisionSets> = new Map();

/**
 * Every supported chain's label decisions, read off the public-feed grid, for
 * DISPLAY. A chain whose feed has not answered is absent from the map.
 *
 * Like `useAllChainsPriceMap` it only reads the scheduler, so a component
 * cannot cause a request. It also ignores the spend-time age bound
 * (services/label-decision-feed.ts readLabelDecisions): that bound refuses a
 * proof, and an older snapshot is still the best evidence a history row has.
 */
export function useLabelDecisionsByChain(): ReadonlyMap<number, LabelDecisionSets> {
  const keys = useMemo(() => supportedEvmChainIds.map((chainId) => ({ chainId, key: feedLabelDecisions(chainId) })), []);

  const subscribe = useCallback((onChange: () => void) => {
    const unsubscribes = keys.map(({ key }) => publicFeeds.subscribe(key, onChange));
    return () => { for (const off of unsubscribes) off(); };
  }, [keys]);

  // getSnapshot runs on every render and is compared by identity: rebuild only
  // when a feed state changed.
  const cache = useRef<{ states: readonly unknown[]; map: ReadonlyMap<number, LabelDecisionSets> } | null>(null);
  const getSnapshot = useCallback(() => {
    const states = keys.map(({ key }) => publicFeeds.read<LabelDecisions>(key));
    const previous = cache.current;
    if (previous && previous.states.every((state, i) => state === states[i])) return previous.map;
    const map = new Map<number, LabelDecisionSets>();
    keys.forEach(({ chainId }, i) => {
      const data = feedData(states[i]);
      if (data) map.set(chainId, { rejected: new Set(data.rejected), poiRequired: new Set(data.poiRequired) });
    });
    cache.current = { states, map };
    return map;
  }, [keys]);

  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
}
