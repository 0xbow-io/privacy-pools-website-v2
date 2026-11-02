import { useQuery } from '@tanstack/react-query';
import {
  fetchRelayerAssetAddressesOrThrow,
  RELAYER_READ_RETRIES,
  relayerAssetSupport,
  relayerRetryDelayMs,
  type RelayerAssetSupport,
} from '@/services/relayer-assets';

/**
 * Whether the chain's relayer lists `tokenAddress` (see services/relayer-assets.ts).
 * 'checking' while the first read and its retries are in flight; 'unknown' only
 * once every retry failed. The read throws on a failure so the retries run: it
 * used to return null, which counted as a good answer and was cached for five
 * minutes, so one throttled read blocked the deposit (2026-11-02).
 */
export function useRelayerAssetSupport(chainId: number | undefined, tokenAddress: string | undefined): RelayerAssetSupport | 'checking' {
  const enabled = !!chainId && !!tokenAddress;
  const { data, isPending } = useQuery({
    queryKey: ['relayer-assets', chainId],
    enabled,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: RELAYER_READ_RETRIES,
    retryDelay: relayerRetryDelayMs,
    refetchOnWindowFocus: false,
    queryFn: () => fetchRelayerAssetAddressesOrThrow(chainId!),
  });
  if (!enabled) return 'unknown';
  if (isPending) return 'checking';
  return relayerAssetSupport(data ?? null, tokenAddress);
}
