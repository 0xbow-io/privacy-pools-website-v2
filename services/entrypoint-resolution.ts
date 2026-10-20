// Entrypoint resolution — PURE module (no react-native imports), extracted
// from components/sdk-provider.tsx so the staging-pin behaviour is
// bun-testable (services/__tests__/entrypoint-resolution.test.ts).
//
// The runtime entrypoint normally comes from the ASP's /entrypoints feed.
// STAGING chains are the exception: their addresses are pinned in
// config/staging-deployments.ts (internal deployments, cross-checked
// on-chain), and the feed has served a wrong row before — the chain-10 (OP
// mainnet) row shipped with "entrypoint" pointing at the pool vault and
// "poolVault" at an unrelated contract. Under feed-first resolution the
// first-on-chain fallback would hand that vault address to the SDK as the
// entrypoint and every deposit would revert at simulation. Pinning makes a
// bad feed row harmless for chains whose addresses we already know.

import { ACTIVE_DEPLOYMENTS_BY_CHAIN } from '@/config/environments';
import type { ChainDeployment } from '@/config/chain-deployment';
import type { EntrypointsResponse, PoolEntrypoint } from '@/services/api-types';

export function resolveEntrypointChainConfig(
  entrypoints: EntrypointsResponse,
  chainId: number,
  poolVault?: string,
  // Injectable for tests; the app always uses the ACTIVE environment's pins
  // (prod or staging, never both).
  stagingByChain: Record<number, ChainDeployment> = ACTIVE_DEPLOYMENTS_BY_CHAIN,
): PoolEntrypoint | undefined {
  const staging = stagingByChain[chainId];
  if (staging) {
    return {
      poolId: '',
      chainId: String(chainId),
      entrypoint: staging.entrypoint,
      poolVault: staging.pool,
      fromBlock: Number(staging.fromBlock),
    };
  }
  const onChain = entrypoints.pools.filter((pool) => Number(pool.chainId) === chainId);
  // A chain may host several pools; pick the one whose vault matches our
  // configured pool (chains.ts poolAddress). Fall back to the first on-chain
  // pool for single-pool chains or when no vault is configured.
  if (poolVault) {
    const match = onChain.find((pool) => pool.poolVault?.toLowerCase() === poolVault.toLowerCase());
    if (match) return match;
  }
  return onChain[0];
}
