/**
 * Per-asset statistics (asp-v2's /:chainId/public/asset-statistics), for every
 * asset in this build's catalog, on the feed grid.
 *
 * The pool page used to fetch its own asset's figures when it mounted, so the
 * request announced which pool page this client had just opened, and its
 * X-Asset header named the asset. Every client now asks for every catalogued
 * asset on the same instants, in one read that names none
 * (services/asset-statistics-read.ts), and the page reads the copy.
 *
 * A 404 (endpoint not deployed, or asset unknown to the ASP) is a value, null,
 * and the page omits the figures; it is not retried off the grid.
 */
import apiClient from '@/services/api-client';
import { getActionableTokens } from '@/config/tokens';
import { resolveConfiguredEntrypoint } from '@/services/pool-entrypoint';
import { readAssetStatistics, type AssetStatisticsByToken, type AssetStatisticsSource } from '@/services/asset-statistics-read';

export type { AssetStatisticsByToken } from '@/services/asset-statistics-read';

export const ASSET_STATISTICS_INTERVAL_MS = 5 * 60_000;

export function feedAssetStatistics(chainId: number | string): string {
  return `asset-statistics:${chainId}`;
}

const ASP_SOURCE: AssetStatisticsSource = {
  tokens: getActionableTokens,
  entrypoint: (chainId) => resolveConfiguredEntrypoint(chainId).catch(() => undefined),
  all: (chainId) => apiClient.getAllAssetStatistics(chainId),
  one: (chainId, tokenAddress) => apiClient.getAssetStatistics(chainId, tokenAddress),
};

const lastGood = new Map<number, AssetStatisticsByToken>();

/** One chain's catalog; an asset whose read fails keeps its last good figures. */
export async function fetchAssetStatisticsFeed(chainId: number): Promise<AssetStatisticsByToken> {
  const out = await readAssetStatistics(chainId, ASP_SOURCE, lastGood.get(chainId) ?? {});
  lastGood.set(chainId, out);
  return out;
}
