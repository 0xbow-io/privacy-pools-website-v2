import { useSyncExternalStore } from 'react';
import { getYieldDeploymentForChain } from '@/config/yield';
import type { YieldDeployment } from '@/services/sdk-types';
import { subscribeYieldVaultProbe, yieldVaultProbeVersion } from '@/services/yield-vault-probe';

/**
 * Re-render when a yield vault probe lands.
 *
 * config/yield's getYieldDeploymentForChain now answers undefined until the
 * vault is verified on chain (services/yield-vault-probe.ts). The deposit modal
 * memoises that answer on chainId, and a provider mounts long before any probe
 * has run, so without this the memo would hold the pre-probe value forever and
 * the toggle could show yield for a vault the session had already refused.
 * Putting this counter in the memo's dependency list re-evaluates it the moment
 * the probe records a verdict.
 */
export function useYieldVaultProbeVersion(): number {
  return useSyncExternalStore(subscribeYieldVaultProbe, yieldVaultProbeVersion, yieldVaultProbeVersion);
}

/**
 * The first VERIFIED yield deployment on `chainId`, re-read whenever a probe
 * lands. For components that mount before the probe (the Portfolio page).
 */
export function useVerifiedYieldDeploymentForChain(chainId: number): YieldDeployment | undefined {
  useYieldVaultProbeVersion();
  return getYieldDeploymentForChain(chainId);
}
