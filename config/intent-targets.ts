// Registry adapter for the pure final-leg rule. Keep this free of chains/tokens
// (and React Native) so the builders and their Bun tests share the real gate.
import { ACTIVE_ENVIRONMENT, NATIVE_ASSET_ADDRESS, type TokenMetadata } from '@/config/environments';
import {
  getConfiguredDepositRouteForPayToken,
  getConfiguredNativeYieldDeployment,
  getConfiguredYieldDeployments,
} from '@/config/yield';
import { conversionTargetRefusal, type TargetRouteFacts } from '@/services/entrypoint-only-route';
import { nativeSwapDepositSupported } from '@/services/native-swap-executor';

export function configuredTargetRoute(
  token: TokenMetadata | undefined,
  chainId: number,
  superseded = false,
  bridgedEntrypointDeposit = false,
): TargetRouteFacts {
  // The inventory outlives feature flags. Turning yield off cannot make its
  // legacy plain pool a safe destination again.
  const deployments = ACTIVE_ENVIRONMENT.yieldDeployments?.[chainId] ?? [];
  return {
    chainId,
    superseded,
    bridgedEntrypointDeposit,
    nativeSwapDeposit: nativeSwapDepositSupported(chainId),
    nativeYieldConfigured: !!getConfiguredNativeYieldDeployment(chainId)
      || deployments.some((d) => d.nativeMode === true),
    yieldRouteConfigured: !!token && (!!getConfiguredDepositRouteForPayToken(chainId, token)
      || deployments.some((d) => d.underlying.toLowerCase() === token.address.toLowerCase())),
    // ENABLING, so it reads the CONFIGURED gate rather than the raw inventory:
    // a build with yield switched off must not offer a share as a destination.
    shareRouteConfigured: !!token?.yieldShare
      && getConfiguredYieldDeployments(chainId).some(
        (d) => d.ppUSDC.toLowerCase() === token.address.toLowerCase(),
      ),
  };
}

export function intentTargetRefusal(address: string, chainId: number, superseded = false, bridgedEntrypointDeposit = false): string | null {
  const token = ACTIVE_ENVIRONMENT.tokensByChain[chainId]?.[address.toLowerCase()];
  return conversionTargetRefusal(token, configuredTargetRoute(token, chainId, superseded, bridgedEntrypointDeposit));
}

export function targetAcceptsConversion(token: TokenMetadata | undefined, chainId: number, superseded = false, bridgedEntrypointDeposit = false): boolean {
  return !!token && intentTargetRefusal(token.address, chainId, superseded, bridgedEntrypointDeposit) === null;
}

/**
 * Is this address a CONFIGURED yield share on that chain?
 *
 * Separate from `targetAcceptsConversion`, which answers whether a conversion
 * may land there. This answers what the asset IS, so a caller can require the
 * extra capability a share needs (its chain's router, reachable from the
 * session actually in hand) rather than inferring it from config.
 */
export function isConfiguredShareTarget(address: string, chainId: number): boolean {
  const token = ACTIVE_ENVIRONMENT.tokensByChain[chainId]?.[address.toLowerCase()];
  return !!token?.yieldShare;
}

/** Defense in depth at every quote/build boundary, including direct callers. */
export function assertIntentDepositTarget(address: string, chainId: number, bridgedEntrypointDeposit = false): void {
  const refusal = intentTargetRefusal(address, chainId, false, bridgedEntrypointDeposit);
  if (refusal) throw new Error(refusal);
}

/**
 * The pool a conversion should actually target for a pay/destination asset: the
 * configured share when this chain wraps that asset, else the asset itself. The
 * swap buys the asset either way; only the final deposit call differs.
 */
export function conversionDepositTarget(address: string, chainId: number, isNative: boolean): string {
  const route = getConfiguredDepositRouteForPayToken(chainId, { address, isNative });
  return route?.ppUSDC ?? address;
}

/**
 * What a swap must DELIVER for a conversion into this pool. A share pool is
 * funded with its underlying (or the chain's coin in native mode) and the
 * router mints the share; asking a DEX for the share itself finds no liquidity,
 * which is why quotes and previews must name this token while the deposit call
 * names the pool (Octavio, relayer team, 2026-09-04, on why shares were kept
 * out of swap routing at all).
 */
export function conversionFundingToken(address: string, chainId: number): string {
  const share = getConfiguredYieldDeployments(chainId).find(
    (d) => d.ppUSDC.toLowerCase() === address.toLowerCase(),
  );
  if (!share) return address;
  return share.nativeMode === true ? NATIVE_ASSET_ADDRESS : share.underlying;
}

/**
 * Pools on `chainId` a swap-funded deposit can actually land in today. Answers
 * about the POOLS only: whether this build and LiFi serve the chain at all is
 * the caller's question (config/intent-swaps.ts asks both).
 * `bridgedEntrypointDeposit` marks a deposit the bridge executes on arrival.
 * Shares stay on the list either way (their router takes the deposit), but a
 * plain native coin drops off it: see services/entrypoint-only-route.ts. The
 * flow must also check that its destination session carries the share namespace.
 */
export function conversionTargetsFor(chainId: number, bridgedEntrypointDeposit = false): string[] {
  const seen = new Set<string>();
  for (const token of Object.values(ACTIVE_ENVIRONMENT.tokensByChain[chainId] ?? {})) {
    seen.add(conversionDepositTarget(token.address, chainId, token.isNative).toLowerCase());
  }
  return [...seen].filter((address) => intentTargetRefusal(address, chainId, false, bridgedEntrypointDeposit) === null);
}
