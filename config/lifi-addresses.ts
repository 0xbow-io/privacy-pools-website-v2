// LiFi's own published contract addresses, pinned per chain.
//
// WHY THIS FILE EXISTS
//
// A swap-and-deposit asks the user's wallet for an ERC-20 allowance before the
// route runs. That allowance is the single most dangerous thing this app ever
// puts in front of a wallet: whoever holds it can move the user's tokens until
// it is spent or taken back. So the spender may not be something this app
// derived, inferred, or picked up from an unverified field. It has to be an
// address LiFi publishes as an approval target, and it has to match one of the
// values below.
//
// The source is lifinance/contracts `deployments/<chain>.json` (read
// 2026-09-21). Only two roles from those files belong here:
//
//   ERC20Proxy   the canonical approval target. Access-controlled: only the
//                Diamond can drive it, so an allowance sitting on it cannot be
//                spent by a stranger.
//   LiFiDiamond  the router itself, and an approval target for the routes that
//                pull directly rather than through the proxy. Same address on
//                every chain LiFi has deployed to.
//
// Everything else LiFi deploys is deliberately absent, and the Executor most of
// all. The Executor's `swapAndExecute` is permissionless: anyone may call it
// and have it perform arbitrary calls with whatever allowances it is holding.
// An allowance left standing on it is spendable by the first bot that notices.
// It is listed separately below so the flow can name it when it refuses.

import type { Address } from '@/services/sdk-types';

/** Same address on every chain LiFi serves. */
const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';

/**
 * Addresses a swap route may name as its approval target, by chain id.
 * Lowercased on read, never at rest, so these stay copy-pasteable against the
 * published deployment files.
 */
const LIFI_APPROVAL_TARGETS: Record<number, readonly string[]> = {
  // Ethereum
  1: ['0x68E1Acfa805dcA813116Ed6507E01c38D44318f0', LIFI_DIAMOND],
  // Optimism
  10: ['0x314bE5fcf0A204837896e6028C47A9e1FC2919c7', LIFI_DIAMOND],
  // BNB Chain
  56: ['0x5741A7FfE7c39Ca175546a54985fA79211290b51', LIFI_DIAMOND],
  // Base (deployments/base.json, read 2026-09-24)
  8453: ['0x74a55CaDb12501A3707E9F3C5dfd8b563C6A5940', LIFI_DIAMOND],
};

/**
 * LiFi Executors. Never an approval target. Named only so a refusal can say
 * what the route asked for instead of printing a bare address.
 */
const LIFI_EXECUTORS: Record<number, readonly string[]> = {
  1: ['0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88'],
  10: ['0xC9E66aa9b08EB667e450e072E96F7086AD9f2c91'],
  56: ['0x2dfaDAB8266483beD9Fd9A292Ce56596a2D1378D'],
  8453: ['0x4DaC9d1769b9b304cb04741DCDEb2FC14aBdF110'],
};

/** Every chain this file can answer for. */
export function lifiAddressesKnownForChain(chainId: number): boolean {
  return LIFI_APPROVAL_TARGETS[chainId] !== undefined;
}

/** Is `address` an approval target LiFi publishes for `chainId`? */
export function isLifiApprovalTarget(chainId: number, address: string | undefined | null): boolean {
  if (!address) return false;
  const targets = LIFI_APPROVAL_TARGETS[chainId];
  if (!targets) return false;
  const wanted = address.toLowerCase();
  return targets.some((known) => known.toLowerCase() === wanted);
}

/** Is `address` a LiFi Executor on `chainId`? */
export function isLifiExecutor(chainId: number, address: string | undefined | null): boolean {
  if (!address) return false;
  const executors = LIFI_EXECUTORS[chainId];
  if (!executors) return false;
  const wanted = address.toLowerCase();
  return executors.some((known) => known.toLowerCase() === wanted);
}

/** The approval targets published for a chain, for messages and tests. */
export function lifiApprovalTargets(chainId: number): readonly Address[] {
  return (LIFI_APPROVAL_TARGETS[chainId] ?? []) as readonly Address[];
}
