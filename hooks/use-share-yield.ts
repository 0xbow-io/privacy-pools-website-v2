import { useQuery } from '@tanstack/react-query';
import type { Address } from 'viem';
import { usePublicClient } from 'wagmi';
import { fetchShareYield, getYieldShareToken, type ShareYield } from '@/services/share-yield';

export interface ShareYieldState {
  /** True while the token is a configured share and the reads are in flight. */
  loading: boolean;
  /** The live figures, or null when the token is not a share or the reads failed. */
  yield: ShareYield | null;
}

const STALE_MS = 5 * 60_000;

/**
 * Live on-chain APY for a yield-bearing pool share (ppUSDC / ppUSDT). Disabled,
 * and null, for any token that is not flagged `yieldShare` in the active
 * environment, so a plain asset never gets a rate. A failed read stays null:
 * the surfaces omit the figure rather than show a stale or made-up one.
 */
export function useShareYield(params: { chainId: number | undefined; tokenAddress: string | undefined; enabled?: boolean }): ShareYieldState {
  const { chainId, tokenAddress, enabled = true } = params;
  const share = getYieldShareToken(chainId, tokenAddress);
  const publicClient = usePublicClient({ chainId: share ? chainId : undefined });
  const active = enabled && !!share && !!publicClient;
  const { data, isPending } = useQuery({
    queryKey: ['share-yield', chainId, share?.address.toLowerCase()],
    enabled: active,
    staleTime: STALE_MS,
    gcTime: 30 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
    queryFn: () => fetchShareYield(publicClient!, share!.address as Address),
  });
  return { loading: active && isPending, yield: active ? data ?? null : null };
}
