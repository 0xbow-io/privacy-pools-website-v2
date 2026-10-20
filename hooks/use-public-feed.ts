import { useCallback, useSyncExternalStore } from 'react';

import {
  EMPTY_FEED_STATE,
  publicFeeds,
  type FeedState,
  type PublicFeedKey,
} from '@/services/public-feed-scheduler';

// Feeds start in a client effect; there is no serialized server cache. Keep
// hydration's initial value independent of any already-populated client cache.
const getServerSnapshot = () => EMPTY_FEED_STATE;

/**
 * Read a public feed from the cache.
 *
 * There is deliberately no `refetch`, no `enabled`, and no `staleTime`. A
 * component cannot cause a request, so mounting one says nothing about this
 * client to anyone watching the network — which is the point of the scheduler
 * and would be undone by a single convenience door.
 *
 * A component with no data yet gets `{ status: 'empty' }` and should render a
 * loading state. That is the honest shape for data it is not allowed to
 * demand.
 *
 * `useSyncExternalStore` rather than state + an effect: an effect that
 * subscribed after paint would miss a value that arrived in between, and the
 * usual fix for that is a fetch on mount, which is the thing being prevented.
 */
export function usePublicFeed<T>(key: PublicFeedKey): FeedState<T> {
  const subscribe = useCallback(
    (onChange: () => void) => publicFeeds.subscribe(key, onChange),
    [key],
  );
  // The scheduler stores one immutable state object per feed and replaces it
  // on change, so this is referentially stable between updates and does not
  // loop.
  const getSnapshot = useCallback(() => publicFeeds.read<T>(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
