import { parseRelayerChainDetails } from './relayer-details';
import { policedFetch } from './egress-fetch';
import { createPublicClient, fallback, type Address } from 'viem';
import { getChainConfig } from '@/config/chains';
import { getActionableTokens } from '@/config/tokens';
import { policedHttp } from './egress-transport';
import { resolveConfiguredEntrypoint } from './pool-entrypoint';
import { ENTRYPOINT_ASSETS_ABI, getVettingFeeBPS, type EntrypointAssetConfig } from './entrypoint-assets';
import { SWAP_PREVIEW_CONFIG_INTERVAL_MS, swapPreviewConfigKey, type SwapPreviewConfigs } from './swap-preview-config';

// All configured chains are registered on the fixed public-feed grid. Shared
// relayer hosts reuse one promise per grid interval, including failed reads.
const catalogs = new Map<string, { tick: number; promise: Promise<ReturnType<typeof parseRelayerChainDetails>[]> }>();
const clients = new Map<number, ReturnType<typeof createPublicClient>>();

function relayerCatalog(base: string) {
  const tick = Math.floor(Date.now() / SWAP_PREVIEW_CONFIG_INTERVAL_MS);
  const cached = catalogs.get(base);
  if (cached?.tick === tick) return cached.promise;
  const promise = policedFetch('relayer', base, `${base}/v1/details`, { signal: AbortSignal.timeout(8_000) })
    .then(async (response) => response.ok ? (await response.json()).chains : [])
    .then((chains: unknown) => Array.isArray(chains) ? chains.map(parseRelayerChainDetails).filter((chain) => chain !== null) : [])
    .catch(() => []);
  catalogs.set(base, { tick, promise });
  return promise;
}

export async function fetchSwapPreviewConfigs(chainId: number): Promise<SwapPreviewConfigs> {
  const result: SwapPreviewConfigs = {};
  const chain = getChainConfig(chainId);
  const base = chain?.relayerBaseUrl?.replace(/\/+$/, '');
  const detailsPromise = base ? relayerCatalog(base) : Promise.resolve([]);
  const urls = chain?.rpcUrls ?? [];
  if (!urls.length) return result;
  let client = clients.get(chainId);
  if (!client) {
    client = createPublicClient({ transport: fallback(urls.map((url) => policedHttp(url, { timeout: 5_000, retryCount: 0 })), { retryCount: 0 }) });
    clients.set(chainId, client);
  }
  const entrypoint = await resolveConfiguredEntrypoint(chainId);
  if (!entrypoint) return result;
  await Promise.all(getActionableTokens(chainId).map(async ({ address }) => {
    try {
      // These reads are independent: neither waits for the other to start.
      const [config, chains] = await Promise.all([
        client.readContract({ address: entrypoint as Address, abi: ENTRYPOINT_ASSETS_ABI, functionName: 'assets', args: [address as Address] }) as Promise<EntrypointAssetConfig>,
        detailsPromise,
      ]);
      const fee = chains.find((details) => details?.id === chainId)?.assets.find((asset) => asset.address.toLowerCase() === address.toLowerCase());
      const flat = fee?.fixedFeeAmount;
      const bps = fee?.feeBPS;
      result[swapPreviewConfigKey(chainId, address)] = {
        ...(flat != null && /^\d+$/.test(String(flat)) ? { relayerFlatFee: BigInt(flat) } : {}),
        ...(bps != null && /^\d+$/.test(String(bps)) ? { relayerFeeBps: BigInt(bps) } : {}),
        enabled: 'enabled' in config ? config.enabled : config[0],
        vettingFeeBps: getVettingFeeBPS(config),
        maxRelayFee: 'maxRelayFee' in config ? config.maxRelayFee : config[3],
      };
    } catch { /* Unknown until the next fixed tick, never assume zero fees. */ }
  }));
  return result;
}
