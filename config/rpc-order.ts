/**
 * RPC endpoint preference order. PURE module (no react-native/DOM imports) so
 * bun tests can exercise it directly - config/env.ts pulls in enough to make it
 * untestable, which is the same reason config/relayer-eras.ts lives apart.
 *
 * Order, primary first:
 *   1. Alchemy, when an Alchemy key is configured
 *   2. the explicit *_RPC_FALLBACK_URL standby (a QuickNode endpoint belongs here)
 *   3. the *_RPC_URL - still honoured, but no longer primary
 *   4. a public node, so the app works with nothing configured
 *
 * Consumers wrap the list in viem's `fallback()`, so a failing or rate-limiting
 * primary rolls over instead of failing the call. This ordering is deliberate:
 * an explicit RPC_URL used to win outright, which is how the deployed app sat on
 * a rate-limited endpoint that shed 72 of 232 block reads in one measured load
 * while an Alchemy key sat unused in the same environment.
 *
 * Escape hatch: to force one endpoint as primary (a local node, a fork), leave
 * the Alchemy key unset for that deployment.
 */
/**
 * Alchemy's per-network hostnames, keyed by chain id, so ANY chain the app
 * registers picks Alchemy up automatically from EXPO_PUBLIC_ALCHEMY_KEY rather
 * than needing its endpoint spelled out per deployment.
 *
 * Only hosts confirmed against the live API belong here. A chain absent from
 * this map simply has no Alchemy primary and falls back to its configured or
 * public endpoint - which is the correct behaviour for a network Alchemy does
 * not serve (Citrea, for one).
 *
 * Verified 2026-08-27 with the project key: eth-sepolia, eth-mainnet,
 * opt-mainnet and bnb-mainnet all answered.
 */
export const ALCHEMY_HOST_BY_CHAIN: Record<number, string> = {
  1: 'eth-mainnet.g.alchemy.com',
  10: 'opt-mainnet.g.alchemy.com',
  56: 'bnb-mainnet.g.alchemy.com',
  137: 'polygon-mainnet.g.alchemy.com',
  8453: 'base-mainnet.g.alchemy.com',
  42161: 'arb-mainnet.g.alchemy.com',
  // Robinhood Chain mainnet: answered eth_chainId 4663 with the project key 2026-10-14.
  4663: 'robinhood-mainnet.g.alchemy.com',
  11155111: 'eth-sepolia.g.alchemy.com',
  11155420: 'opt-sepolia.g.alchemy.com',
  84532: 'base-sepolia.g.alchemy.com',
  421614: 'arb-sepolia.g.alchemy.com',
  97: 'bnb-testnet.g.alchemy.com',
};

/** Alchemy host for a chain, or undefined when Alchemy does not serve it. */
export function alchemyHostFor(chainId: number): string | undefined {
  return ALCHEMY_HOST_BY_CHAIN[chainId];
}

export function buildRpcOrder(
  alchemyKey: string | undefined,
  alchemyHost: string | undefined,
  configuredFallback: string | undefined,
  configured: string | undefined,
  publicFallback: string,
): string[] {
  const ordered = [
    alchemyKey && alchemyHost ? `https://${alchemyHost}/v2/${alchemyKey}` : undefined,
    configuredFallback,
    configured,
    publicFallback,
  ]
    .map((u) => u?.trim())
    .filter((u): u is string => !!u && u.length > 0);
  // De-dupe, so an endpoint is never retried as its own fallback.
  return Array.from(new Set(ordered));
}
