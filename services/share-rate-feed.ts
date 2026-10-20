import { policedHttp } from '@/services/egress-transport';
import { createPublicClient, fallback } from 'viem';
import { getChainConfig, supportedChainIds } from '@/config/chains';
import { getKnownTokenMetadata } from '@/config/tokens';
import { getConfiguredYieldDeployments } from '@/config/yield';
import { fetchAssetsPerShare, shareRateKey, type ShareDeploymentRef, type ShareRate } from '@/services/share-rates';
import { readShareRateSeries, type RateHistoryClient, type ShareRateSeries } from '@/services/share-rate-history';

// App-only: deployment scope comes from static build configuration, never holdings.
export const FEED_SHARE_RATE_BOOK = 'share-rate-book';
export const FEED_SHARE_RATES = 'share-rates';
export const SHARE_RATE_INTERVAL_MS = 60_000;

/**
 * Every CONFIGURED yield share on the EVM chains this build serves. Configured, not
 * probe-verified: the verified list is empty until the deposit flow's vault probe has
 * run, which on the home page is never, so the rows kept printing share counts
 * (Pat, 2026-09-05). A convertToAssets read against a configured address is
 * harmless; a bogus vault just fails the read and keeps the fallback.
 */
export function listShareDeployments(): ShareDeploymentRef[] {
  const out: ShareDeploymentRef[] = [];
  for (const chainId of supportedChainIds) {
    if (getChainConfig(chainId)?.chainType !== 'evm') continue;
    for (const d of getConfiguredYieldDeployments(chainId)) {
      out.push({
        chainId,
        share: d.ppUSDC.toLowerCase(),
        underlying: d.underlying.toLowerCase(),
        shareSymbol: getKnownTokenMetadata(d.ppUSDC, chainId)?.symbol ?? `pp${d.underlyingSymbol.toUpperCase()}`,
        shareDecimals: d.ppUSDCDecimals,
        underlyingSymbol: d.underlyingSymbol.toUpperCase(),
        underlyingDecimals: d.underlyingDecimals,
      });
    }
  }
  return out;
}

// One stateless client per chain, built once: the reads recur every minute.
const clientByChain = new Map<number, ReturnType<typeof createPublicClient>>();
function clientFor(chainId: number): ReturnType<typeof createPublicClient> | null {
  const cached = clientByChain.get(chainId);
  if (cached) return cached;
  const urls = (getChainConfig(chainId)?.rpcUrls ?? []).filter(Boolean);
  if (urls.length === 0) return null;
  // Bounded like the vault probe: 5 s per URL, no retries. A share whose rate
  // cannot be read keeps its share count on screen.
  const client = createPublicClient({ transport: fallback(urls.map((u) => policedHttp(u, { timeout: 5_000 })), { retryCount: 0 }) });
  clientByChain.set(chainId, client);
  return client;
}

// Build-static: the environment does not change without a reload.
export const SHARE_DEPLOYMENTS = listShareDeployments();

export type ShareRateBook = Map<string, ShareRateSeries>;

const BOOK_TTL_MS = 10 * 60_000;
const bookByChain = new Map<number, { at: number; series: Promise<ShareRateSeries[]> }>();

function seriesForChain(chainId: number): Promise<ShareRateSeries[]> {
  const cached = bookByChain.get(chainId);
  if (cached && Date.now() - cached.at < BOOK_TTL_MS) return cached.series;
  const client = clientFor(chainId);
  const fromBlock = getChainConfig(chainId)?.contracts?.fromBlock;
  const refs = SHARE_DEPLOYMENTS.filter((r) => r.chainId === chainId);
  const series = client && fromBlock != null
    ? readShareRateSeries(client as unknown as RateHistoryClient, refs, fromBlock).then((result) => {
      if (!result.some((s) => s.current != null) && bookByChain.get(chainId)?.series === series) {
        bookByChain.delete(chainId);
      }
      return result;
    }).catch(() => {
      if (bookByChain.get(chainId)?.series === series) bookByChain.delete(chainId);
      return [];
    })
    : Promise.resolve([]);
  // Expire on shared ten-minute windows, not ten minutes after page arrival.
  const at = Math.floor(Date.now() / BOOK_TTL_MS) * BOOK_TTL_MS;
  bookByChain.set(chainId, { at, series });
  return series;
}

/**
 * Past and current rates for every configured share, keyed by shareRateKey.
 * Reads every share chain whatever the caller holds, so the request set does
 * not depend on which assets a user has.
 */
export async function fetchShareRateBook(): Promise<ShareRateBook> {
  const chainIds = [...new Set(SHARE_DEPLOYMENTS.map((r) => r.chainId))];
  const all = await Promise.all(chainIds.map(seriesForChain));
  const book: ShareRateBook = new Map();
  for (const s of all.flat()) book.set(shareRateKey(s.ref.chainId, s.ref.share), s);
  return book;
}

export async function fetchShareRates(): Promise<Record<string, ShareRate>> {
  const out: Record<string, ShareRate> = {};
  await Promise.all(SHARE_DEPLOYMENTS.map(async (ref) => {
    const client = clientFor(ref.chainId);
    if (!client) return;
    try {
      const assetsPerShare = await fetchAssetsPerShare(client, ref);
      out[shareRateKey(ref.chainId, ref.share)] = { ...ref, assetsPerShare };
    } catch {
      /* fail-soft: no conversion for this share until the next scheduled tick */
    }
  }));
  return out;
}
