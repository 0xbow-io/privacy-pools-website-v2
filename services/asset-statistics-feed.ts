/**
 * Per-asset statistics (asp-v2's /:chainId/public/asset-statistics), for every
 * asset in this build's catalog, on the feed grid.
 *
 * The pool page used to fetch its own asset's figures when it mounted, so the
 * request announced which pool page this client had just opened, and its
 * X-Asset header named the asset. Every client now asks for every catalogued
 * asset on the same instants, and the page reads the copy.
 *
 * A 404 (endpoint not deployed, or asset unknown to the ASP) is a value, null,
 * and the page omits the figures; it is not retried off the grid.
 */
import apiClient from '@/services/api-client';
import type { AssetStatistics } from '@/services/api-types';
import { getActionableTokens } from '@/config/tokens';

export const ASSET_STATISTICS_INTERVAL_MS = 5 * 60_000;

export function feedAssetStatistics(chainId: number | string): string {
  return `asset-statistics:${chainId}`;
}

/** Keyed by lowercase token address; null where the ASP has no figures. */
export type AssetStatisticsByToken = Record<string, AssetStatistics | null>;

const lastGood = new Map<number, AssetStatisticsByToken>();

/**
 * One chain's catalog, one asset at a time so a tick is not a burst. An asset
 * whose request fails keeps its last good figures; the tick fails only when
 * every asset did.
 */
export async function fetchAssetStatisticsFeed(chainId: number): Promise<AssetStatisticsByToken> {
  const previous = lastGood.get(chainId) ?? {};
  const out: AssetStatisticsByToken = {};
  let answered = 0;
  let failure: unknown = null;
  for (const token of getActionableTokens(chainId)) {
    const key = token.address.toLowerCase();
    try {
      const res = await apiClient.getAssetStatistics(chainId, token.address);
      out[key] = res.asset ?? null;
      answered += 1;
    } catch (err) {
      if ((err as { statusCode?: number })?.statusCode === 404) {
        out[key] = null;
        answered += 1;
      } else {
        failure = err;
        if (key in previous) out[key] = previous[key];
      }
    }
  }
  if (answered === 0 && failure) throw failure;
  lastGood.set(chainId, out);
  return out;
}
