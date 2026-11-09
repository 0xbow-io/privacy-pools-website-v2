// Pure final-leg rules. The caller supplies CONFIGURED routing facts, never a
// vault probe result: a pending/failed probe must not reopen a legacy pool.
import { displayTokenSymbol } from '@/services/share-display';
import { VAULT_DEPOSITS_PAUSED_MESSAGE } from '@/config/yield-deposits-paused';

export interface EntrypointTarget {
  symbol?: string;
  isNative?: boolean;
  withdrawOnly?: boolean;
  depositComingSoon?: boolean;
  /** Vault deposits paused (set with depositComingSoon, config/yield-deposits-paused.ts). */
  depositPaused?: boolean;
  yieldShare?: string;
}

export interface TargetRouteFacts {
  chainId: number;
  superseded?: boolean;
  nativeYieldConfigured?: boolean;
  yieldRouteConfigured?: boolean;
  /**
   * This target IS a configured yield share whose PPRouter this build can fund,
   * so a conversion can end in `depositExactShares` / `depositExactSharesNative`
   * instead of the Entrypoint deposit no share pool accepts (SDK 36e533e8).
   * Computed from the CONFIGURED yield table, never from a vault probe.
   */
  shareRouteConfigured?: boolean;
  /**
   * The final deposit is a destination call the BRIDGE executes: LiFi's
   * executor runs calldata fixed at quote time, minutes later, on the far
   * chain. Both cross-chain forms have one (the reshield and the wallet-funded
   * swap-deposit), and when it reverts the bridge's recovery pays the fallback
   * address, a public wallet.
   *
   * A share is reachable this way: its router takes the deposit, and the SDK
   * sizes it under the route's guaranteed delivery since v2-monorepo#437. The
   * 2026-09-22 mainnet to BNB reshield into ppUSDT reverted because it was
   * sized above that guarantee.
   *
   * A plain native coin is not. `Entrypoint.deposit{value}` needs `msg.value`
   * to equal the proof's amount exactly, and the executor sends its own
   * guaranteed delivery instead, so the call can never succeed (three BNB
   * losses, 2026-09-22/23). A share in native mode (ppETH) is exempt: its
   * router caps `msg.value` and refunds the rest.
   */
  bridgedEntrypointDeposit?: boolean;
  /**
   * Same-chain only: can the SDK compose the swap-then-deposit for a plain
   * native coin on this chain (a LiFi Executor is known for it)? Without one
   * the SDK throws `NativeSwapDepositUnavailable` (v2-monorepo#477). Left
   * undefined it is not checked.
   */
  nativeSwapDeposit?: boolean;
}

/** Plain deposits may hold shares, but cannot enter a closed/replaced pool. */
export function entrypointOnlyTargetBlocked(
  token: EntrypointTarget | null | undefined,
  route: TargetRouteFacts,
): boolean {
  return !token || !Number.isSafeInteger(route.chainId) || route.chainId <= 0
    || token.withdrawOnly === true || token.depositComingSoon === true
    || route.superseded === true
    || (token.isNative === true && route.nativeYieldConfigured === true)
    || route.yieldRouteConfigured === true;
}

/**
 * A conversion buys the target and ends in ONE deposit call. For a plain pool
 * that is `Entrypoint.deposit`. For a yield share it is the share's PPRouter
 * deposit, which the SDK builds only when this build knows that router and the
 * session preparing the deposit is the pool chain's; without both, a share
 * target would end in the Entrypoint deposit no share pool accepts.
 */
export function targetAcceptsConversion(
  token: EntrypointTarget | null | undefined,
  route: TargetRouteFacts,
): boolean {
  if (entrypointOnlyTargetBlocked(token, route)) return false;
  // A share needs its chain's router, whichever side the value comes from.
  if (token?.yieldShare) return route.shareRouteConfigured === true;
  // A plain coin cannot be the bridged call's `msg.value`: see
  // `bridgedEntrypointDeposit`.
  if (token?.isNative === true && route.bridgedEntrypointDeposit === true) return false;
  if (token?.isNative === true && route.bridgedEntrypointDeposit !== true && route.nativeSwapDeposit === false) return false;
  return true;
}

export function conversionTargetRefusal(
  token: EntrypointTarget | null | undefined,
  route: TargetRouteFacts,
): string | null {
  if (targetAcceptsConversion(token, route)) return null;
  if (!token) return 'This conversion destination is not available on this network. Pick another pool.';
  if (token.depositPaused === true) return VAULT_DEPOSITS_PAUSED_MESSAGE;
  const symbol = displayTokenSymbol(token.symbol ?? 'This asset');
  if (token.isNative === true && route.bridgedEntrypointDeposit === true && !entrypointOnlyTargetBlocked(token, route)) {
    return `Converting into ${symbol} from another network is not available yet. Pick another asset, or swap into ${symbol} on its own network.`;
  }
  if (token.isNative === true && route.nativeSwapDeposit === false && !entrypointOnlyTargetBlocked(token, route)) {
    return `Receiving ${symbol} from a swap is not available on this network yet. Pick another asset.`;
  }
  if (route.superseded || route.nativeYieldConfigured || route.yieldRouteConfigured || token.yieldShare) {
    return `${symbol} deposits on this network go through the yield vault, and a conversion cannot land there yet. Shield ${symbol} directly instead.`;
  }
  return `${symbol} deposits are closed on this network. Pick another pool for the conversion.`;
}
