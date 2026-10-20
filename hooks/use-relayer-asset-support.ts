import { useQuery } from '@tanstack/react-query';
import { fetchRelayerAssetAddresses, relayerAssetSupport, type RelayerAssetSupport } from '@/services/relayer-assets';

/**
 * Whether the chain's relayer lists `tokenAddress` (see services/relayer-assets.ts).
 * 'checking' while the first read is in flight; 'unknown' when it failed.
 */
export function useRelayerAssetSupport(chainId: number | undefined, tokenAddress: string | undefined): RelayerAssetSupport | 'checking' {
  const enabled = !!chainId && !!tokenAddress;
  const { data, isPending } = useQuery({
    queryKey: ['relayer-assets', chainId],
    enabled,
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
    queryFn: () => fetchRelayerAssetAddresses(chainId!),
  });
  if (!enabled) return 'unknown';
  if (isPending) return 'checking';
  return relayerAssetSupport(data ?? null, tokenAddress);
}
