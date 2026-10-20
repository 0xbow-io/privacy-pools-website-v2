import { createPublicClient, fallback } from 'viem';

import { getChainConfig } from '@/config/chains';
import { policedHttp } from '@/services/egress-transport';

// `eth_gasPrice` from the app's own RPC, never the wallet's provider: the call
// takes no parameters, so it says nothing about the user, and the public-feed
// grid decides when it runs.
const clientByChain = new Map<number, ReturnType<typeof createPublicClient>>();

export async function fetchGasPrice(chainId: number): Promise<bigint> {
  let client = clientByChain.get(chainId);
  if (!client) {
    const urls = (getChainConfig(chainId)?.rpcUrls ?? []).filter(Boolean);
    if (urls.length === 0) throw new Error(`No RPC configured for chain ${chainId}`);
    client = createPublicClient({ transport: fallback(urls.map((url) => policedHttp(url, { timeout: 5_000, retryCount: 0 })), { retryCount: 0 }) });
    clientByChain.set(chainId, client);
  }
  return client.getGasPrice();
}
