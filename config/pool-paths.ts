// Pool page paths and labels with the chain's share/legacy inventory applied.
//
// config/chains.getPoolDetailPath knows chain names; this module knows which
// pools on the chain are yield shares and which plain pools they superseded,
// so `/chains/ethereum/eth` is the ppETH pool and the emptied plain pool
// lives at `/chains/ethereum/eth-legacy` (services/pool-slug.ts has the rule).
// Kept out of config/chains.ts because config/tokens imports it.
import { displayTokenSymbol } from '@/services/share-display';
import { getPoolDetailPath } from '@/config/chains';
import { getActionableTokens } from '@/config/tokens';
import type { TokenMetadata } from '@/config/environments';
import { getConfiguredNativeYieldDeployment, isConfiguredYieldUnderlying } from '@/config/yield';
import { isSupersededPlainPool, poolLabel, poolSlug, poolSymbolFromSlug, type PoolSlugContext } from '@/services/pool-slug';

/**
 * A plain pool whose deposits no longer land in it: closed for good
 * (`withdrawOnly`), or redirected into a share pool on the same chain (the
 * native coin behind a native-mode yield router, an ERC-20 that is a
 * configured yield underlying).
 */
export function isLegacyPlainToken(token: Pick<TokenMetadata, 'address' | 'isNative' | 'withdrawOnly'>, chainId: number): boolean {
  if (token.withdrawOnly) return true;
  // CONFIGURED, not probe-verified: this decides URLs, labels and which rows a
  // directory lists before any vault probe can have run (the pool page never
  // runs one), so the probe-gated lookup left ETH unclassified and /eth fell
  // through to the legacy pool (Pat, 2026-09-18). Money paths keep the probe.
  if (token.isNative) return getConfiguredNativeYieldDeployment(chainId) !== undefined;
  return isConfiguredYieldUnderlying(chainId, token.address);
}

export function poolSlugContext(chainId: number): PoolSlugContext {
  // Existing pools remain addressable when new yield deposits are disabled.
  // The registry describes pool identity; the yield flag only gates actions.
  const shareSymbols = getActionableTokens(chainId)
    .filter((token) => token.yieldShare)
    .map((token) => token.symbol.toUpperCase());
  const openPlainSymbols: string[] = [];
  const legacyPlainSymbols: string[] = [];
  for (const token of getActionableTokens(chainId)) {
    const upper = token.symbol.toUpperCase();
    if (shareSymbols.includes(upper)) continue;
    // Directory identity must not change when deposits are disabled. A known
    // share is the canonical pool; the underlying keeps its legacy URL.
    const replaced = shareSymbols.some((share) => displayTokenSymbol(share).toUpperCase() === upper);
    (replaced || isLegacyPlainToken(token, chainId) ? legacyPlainSymbols : openPlainSymbols).push(upper);
  }
  return { shareSymbols, openPlainSymbols, legacyPlainSymbols };
}

/** `/chains/<chain>/<slug>` for a pool symbol; the chain-agnostic path when no chain is known. */
export function getPoolPath(symbol: string, chainId?: number): string {
  if (chainId == null) return getPoolDetailPath(symbol, chainId);
  return getPoolDetailPath(poolSlug(symbol, poolSlugContext(chainId)), chainId);
}

/** Upper-case token symbol the route segment names on `chainId`. */
export function poolSymbolFromRoute(slug: string, chainId: number): string {
  return poolSymbolFromSlug(slug, poolSlugContext(chainId));
}

/** Picker / heading label for a pool symbol on `chainId`. */
export function poolDisplayLabel(symbol: string, chainId: number): string {
  return poolLabel(symbol, poolSlugContext(chainId));
}

/**
 * A plain pool a share pool on `chainId` has replaced (the legacy ETH pool once
 * ppETH opened). Pool directories drop it so the share is the row that carries
 * the coin's name; the pool stays reachable from My balances and its -legacy URL.
 */
export function isSupersededLegacyPool(symbol: string, chainId: number): boolean {
  return isSupersededPlainPool(symbol, poolSlugContext(chainId));
}
