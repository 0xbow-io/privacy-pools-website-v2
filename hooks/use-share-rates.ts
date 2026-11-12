import { useCallback, useMemo } from 'react';
import { usePublicFeed } from '@/hooks/use-public-feed';
import { feedData } from '@/services/public-feed-scheduler';
import { FEED_SHARE_RATE_BOOK, FEED_SHARE_RATES, SHARE_DEPLOYMENTS, type ShareRateBook } from '@/services/share-rate-feed';
import { shareRateKey, shareRateOf, type ShareRate } from '@/services/share-rates';
import { withoutShareNames, type ShareNameText } from '@/services/share-display';

export type { ShareRateBook } from '@/services/share-rate-feed';

const NO_RATES: readonly ShareRate[] = [];
// One array per feed value, so `rates` keeps its identity between renders
// without a hook (the feed replaces its value object on every change).
const ratesByData = new WeakMap<object, readonly ShareRate[]>();
function ratesOf(data: Record<string, ShareRate> | undefined): readonly ShareRate[] {
  if (!data) return NO_RATES;
  let rates = ratesByData.get(data);
  if (!rates) {
    rates = Object.values(data);
    ratesByData.set(data, rates);
  }
  return rates;
}

/** Read scheduled historical rates without starting or waiting for a request. */
export function useShareRateBook(): ShareRateBook | null {
  return feedData(usePublicFeed<ShareRateBook>(FEED_SHARE_RATE_BOOK)) ?? null;
}

/** Live share rates from the fixed feed grid, independent of component mounts. */
export function useShareRates(): {
  rateFor: (chainId: number, share: string | undefined) => ShareRate | undefined;
  /** Every rate the feed holds, for lookups by symbol (free text). */
  rates: readonly ShareRate[];
  loading: boolean;
} {
  const state = usePublicFeed<Record<string, ShareRate>>(FEED_SHARE_RATES);
  const data = feedData(state);
  // Consumers put rateFor in memo dependencies; keep it stable between updates.
  const rateFor = useCallback(
    (chainId: number, share: string | undefined): ShareRate | undefined => (share ? data?.[shareRateKey(chainId, share)] : undefined),
    [data],
  );
  const rates = ratesOf(data);
  return { rateFor, rates, loading: SHARE_DEPLOYMENTS.length > 0 && state.status === 'empty' };
}

/**
 * withoutShareNames bound to the live rates: a share count quoted in free text
 * (an SDK, relayer or LI.FI message, a step label, a toast) reads as the
 * underlying it is worth once the rate is in, and as the approximate count
 * before. Reads the feed grid only; it never causes a request. Pass the flow's
 * chain when it has one; without it a symbol converts only when every chain
 * agrees on its rate.
 */
export function useShareNameText(chainId?: number): ShareNameText {
  const { rates } = useShareRates();
  return useMemo(() => {
    const rateOf = shareRateOf(rates, chainId, SHARE_DEPLOYMENTS);
    return ((text: string | null | undefined) => withoutShareNames(text, rateOf)) as ShareNameText;
  }, [rates, chainId]);
}
