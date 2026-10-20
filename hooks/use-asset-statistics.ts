import { usePublicFeed } from '@/hooks/use-public-feed';
import { feedData } from '@/services/public-feed-scheduler';
import { feedAssetStatistics, type AssetStatisticsByToken } from '@/services/asset-statistics-feed';
import type { AssetStatistics } from '@/services/api-types';

/**
 * Per-asset statistics (asp-v2 PR #92's /:chainId/public/asset-statistics).
 *
 * This exists because of a review P1 (codex + kimi, 2026-07-28): the pool page
 * was wired to the GLOBAL statistics payload, so the day PR #92 deploys, every
 * pool page would have silently shown the protocol-wide median and transfers
 * count as if they were the pool's own — the same number on every pool. The
 * pool card must only ever read pool-scoped figures from THIS hook; the global
 * payload stays where it belongs (the protocol-wide /explore page).
 *
 * A read of the feed grid's copy (services/asset-statistics-feed.ts), which
 * holds every catalogued asset whatever page is open: opening a pool page
 * cannot cause a request. A 404 reads as null and every figure is OMITTED.
 */
export function useAssetStatistics(params: {
  chainId: number;
  /** Token ADDRESS, as the feed keys it. Omit to disable (Sui). */
  tokenAddress: string | undefined;
  enabled?: boolean;
}): { assetStats: AssetStatistics | null; isPending: boolean } {
  const { chainId, tokenAddress, enabled = true } = params;
  const active = enabled && !!tokenAddress;
  const feed = usePublicFeed<AssetStatisticsByToken>(feedAssetStatistics(chainId));
  const byToken = feedData(feed);
  const assetStats = active && byToken ? byToken[(tokenAddress as string).toLowerCase()] ?? null : null;
  return { assetStats, isPending: active && feed.status === 'empty' };
}
