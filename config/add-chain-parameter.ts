// What we tell a wallet when it has never heard of a chain.
//
// wagmi's connector already falls back to `wallet_addEthereumChain` when a
// wallet answers 4902 ("unrecognized chain") to a switch, deriving parameters
// from the registered viem chain. Passing them explicitly lets us pin the
// chain NAME to the product's own (viem's differs for some networks) and, more
// importantly, choose the endpoints deliberately.
//
// PURE module (no react-native, no config/chains) so it is bun-testable —
// same reason config/relayer-eras.ts and services/note-source.ts are shaped
// this way.

/**
 * Endpoints we refuse to write into someone else's wallet.
 *
 * Our own RPC list leads with Alchemy carrying OUR api key. Handing that to
 * wallet_addEthereumChain persists the key in the user's wallet config
 * indefinitely, and every call their wallet later makes on that chain — from
 * any dapp, not just this one — bills our account. It is also impossible to
 * rotate out of once written. Public endpoints are exactly what this parameter
 * is for; the app keeps using its own transports internally.
 */
export const PRIVATE_RPC = /alchemy|quiknode|infura|ankr\.com\/[a-z0-9]{16,}|\/v2\/[A-Za-z0-9_-]{20,}/i;

export interface ViemChainLike {
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls?: { default?: { http?: readonly string[] } };
  blockExplorers?: { default?: { url?: string } };
}

export interface AddChainParameter {
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
}

/**
 * Build the wallet-facing description of a chain, or undefined when we cannot
 * describe it honestly (no viem chain, or no public endpoint to offer). Undefined
 * lets the connector's own derivation run instead of adding a broken entry.
 */
export function buildAddChainParameter(input: {
  viemChain?: ViemChainLike;
  /** The product's display name, preferred over viem's. */
  displayName?: string;
  /** The app's configured endpoints; private ones are filtered out. */
  configuredRpcUrls?: readonly string[];
}): AddChainParameter | undefined {
  const { viemChain, displayName, configuredRpcUrls } = input;
  if (!viemChain) return undefined;
  const rpcUrls = Array.from(new Set([
    ...(viemChain.rpcUrls?.default?.http ?? []),
    ...(configuredRpcUrls ?? []).filter((url) => !PRIVATE_RPC.test(url)),
  ])).filter((url): url is string => !!url);
  if (rpcUrls.length === 0) return undefined;
  const explorer = viemChain.blockExplorers?.default?.url;
  return {
    chainName: displayName || viemChain.name,
    nativeCurrency: viemChain.nativeCurrency,
    rpcUrls,
    ...(explorer ? { blockExplorerUrls: [explorer] } : {}),
  };
}
