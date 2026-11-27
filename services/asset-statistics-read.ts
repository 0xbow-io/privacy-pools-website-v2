/**
 * One tick of the asset statistics feed (services/asset-statistics-feed.ts),
 * apart from the app's config so a test can drive it.
 *
 * The tick is one read: /asset-statistics/all (asp-v2#252) lists every asset,
 * one entry per pool, and names none. Each catalogued token takes the entry of
 * this build's pool on the chain. The list holds only enabled assets of
 * enabled pools, so a token it leaves out, one several other pools hold, and
 * every token of an ASP that predates the list (404) are asked for per asset,
 * one at a time, as before.
 */
import type { AllAssetStatisticsResponse, AssetStatistics, AssetStatisticsResponse } from '@/services/api-types';

/** Keyed by lowercase token address; null where the ASP has no figures. */
export type AssetStatisticsByToken = Record<string, AssetStatistics | null>;

/** What a tick reads: the chain's catalog, this build's pool, and the ASP. */
export interface AssetStatisticsSource {
  tokens(chainId: number): readonly { address: string }[];
  entrypoint(chainId: number): Promise<string | undefined>;
  all(chainId: number): Promise<AllAssetStatisticsResponse>;
  one(chainId: number, tokenAddress: string): Promise<AssetStatisticsResponse>;
}

const isNotFound = (err: unknown) => (err as { statusCode?: number })?.statusCode === 404;

/**
 * `token`'s entry in the list: the one for this build's pool, else its only
 * one. `undefined` when the list leaves it out (a disabled asset or pool,
 * which the ASP still serves per asset) or several pools hold it and none is
 * ours, so the ASP's own per-asset choice answers instead.
 */
export function pickAssetStatistics(
  list: AllAssetStatisticsResponse,
  token: string,
  entrypoint: string | undefined,
): AssetStatistics | undefined {
  const held = list.assets.filter((entry) => entry.asset.toLowerCase() === token.toLowerCase());
  const ours = entrypoint ? held.find((entry) => entry.entrypoint.toLowerCase() === entrypoint.toLowerCase()) : undefined;
  return ours ?? (held.length === 1 ? held[0] : undefined);
}

/**
 * One chain's catalog. An asset whose per-asset request fails keeps its
 * `previous` figures; the tick fails when every asset did, or when the list
 * read fails other than with a 404.
 */
export async function readAssetStatistics(
  chainId: number,
  source: AssetStatisticsSource,
  previous: AssetStatisticsByToken,
): Promise<AssetStatisticsByToken> {
  const out: AssetStatisticsByToken = {};
  let answered = 0;
  let failure: unknown = null;
  let list: AllAssetStatisticsResponse | null = null;
  try {
    list = await source.all(chainId);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  const entrypoint = list ? await source.entrypoint(chainId) : undefined;
  for (const token of source.tokens(chainId)) {
    const key = token.address.toLowerCase();
    const listed = list ? pickAssetStatistics(list, key, entrypoint) : undefined;
    if (listed !== undefined) {
      out[key] = listed;
      answered += 1;
      continue;
    }
    try {
      const res = await source.one(chainId, token.address);
      out[key] = res.asset ?? null;
      answered += 1;
    } catch (err) {
      if (isNotFound(err)) {
        out[key] = null;
        answered += 1;
      } else {
        failure = err;
        if (key in previous) out[key] = previous[key];
      }
    }
  }
  if (answered === 0 && failure) throw failure;
  return out;
}
