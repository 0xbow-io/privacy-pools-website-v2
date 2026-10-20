import { useCallback } from 'react';
import { usePublicFeed } from '@/hooks/use-public-feed';
import { feedData } from '@/services/public-feed-scheduler';
import { FEED_SHARE_RATE_BOOK, FEED_SHARE_RATES, SHARE_DEPLOYMENTS, type ShareRateBook } from '@/services/share-rate-feed';
import { shareRateKey, type ShareRate } from '@/services/share-rates';

export type { ShareRateBook } from '@/services/share-rate-feed';

/** Read scheduled historical rates without starting or waiting for a request. */
export function useShareRateBook(): ShareRateBook | null {
  return feedData(usePublicFeed<ShareRateBook>(FEED_SHARE_RATE_BOOK)) ?? null;
}

/** Live share rates from the fixed feed grid, independent of component mounts. */
export function useShareRates(): { rateFor: (chainId: number, share: string | undefined) => ShareRate | undefined; loading: boolean } {
  const state = usePublicFeed<Record<string, ShareRate>>(FEED_SHARE_RATES);
  const data = feedData(state);
  // Consumers put rateFor in memo dependencies; keep it stable between updates.
  const rateFor = useCallback(
    (chainId: number, share: string | undefined): ShareRate | undefined => (share ? data?.[shareRateKey(chainId, share)] : undefined),
    [data],
  );
  return { rateFor, loading: SHARE_DEPLOYMENTS.length > 0 && state.status === 'empty' };
}
