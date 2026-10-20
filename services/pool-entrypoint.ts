import { getChainConfig } from '@/config/chains';
import { LEGACY_CONFIG } from '@/config/env';
import apiClient from '@/services/api-client';
import { resolveEntrypointChainConfig } from '@/services/entrypoint-resolution';

/**
 * Resolve the entrypoint address of THIS website's configured pool on a chain.
 *
 * chains.ts pins one pool per chain (its `poolAddress` is the on-chain
 * PoolVault), so when the ASP hosts several pools on the same chain we select
 * the feed entry whose `poolVault` matches our configured pool. The resolved
 * entrypoint is passed to the pool-scoped public endpoints (association-set,
 * label-status) so a multi-pool chain resolves to our pool instead of 400ing.
 *
 * Delegates to the shared resolver so STAGING chains come back PINNED from
 * config rather than from the feed — this module used to be a second,
 * independent feed matcher, and on chain 10 (whose feed row is misregistered)
 * its first-row fallback stamped the WRONG address onto every pool-scoped
 * public request. One resolver, one truth.
 *
 * Returns undefined only if the feed has no pool for the chain — callers then
 * fall back to the chain-only request (valid for single-pool chains).
 */
export async function resolveConfiguredEntrypoint(chainId: number): Promise<string | undefined> {
  // Legacy spend-out build pins the entrypoint explicitly.
  if (LEGACY_CONFIG) return LEGACY_CONFIG.entrypoint;

  const entrypoints = await apiClient.getEntrypoints();
  return resolveEntrypointChainConfig(
    entrypoints,
    chainId,
    getChainConfig(chainId)?.contracts?.poolAddress,
  )?.entrypoint;
}
