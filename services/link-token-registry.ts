// Registry half of services/link-token.ts: reads the environment tables and
// config/tokens, which bun tests cannot import (config/chains pulls in
// react-native).
import { ACTIVE_ENVIRONMENT, ENVIRONMENTS } from '@/config/environments';
import { getKnownTokenMetadata } from '@/config/tokens';
import { linkAmountText, resolveLinkToken, type LinkToken } from '@/services/link-token';

// The active environment first: when two environments list the same address
// on the same chain, the one this page serves wins.
const REGISTRIES = [
  ACTIVE_ENVIRONMENT.tokensByChain,
  ...Object.values(ENVIRONMENTS).filter((env) => env !== ACTIVE_ENVIRONMENT).map((env) => env.tokensByChain),
];

/** The token a link names, from any environment; unknown rather than guessed. */
export function linkToken(address: string, chainId?: number): LinkToken {
  if (chainId !== undefined) {
    const known = getKnownTokenMetadata(address, chainId);
    if (known) return { known: true, symbol: known.symbol, decimals: known.decimals };
  }
  return resolveLinkToken(address, chainId, REGISTRIES);
}

/** The amount line for a link's token (see linkAmountText). */
export function linkAmountLabel(rawAmount: bigint, address: string, chainId?: number): string {
  return linkAmountText(rawAmount, linkToken(address, chainId));
}
