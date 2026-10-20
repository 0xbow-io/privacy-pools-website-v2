import { isSupersededLegacyPool } from '@/config/pool-paths';
// Registry-backed face of the hub token rule (services/hub-token-catalog-rule.ts
// holds the pure rule and its documentation).
import {
  getActionableTokens,
  getDepositableTokens,
  getEntrypointDepositableTokens,
  getKnownTokenMetadata,
  type TokenMetadata,
} from '@/config/tokens';
import { selectHubTokens, type HubAction, type HubHoldings } from '@/services/hub-token-catalog-rule';

export { preferredHubToken, heldSymbolsFor, NO_HOLDINGS, type HubAction, type HubHoldings } from '@/services/hub-token-catalog-rule';

export function hubTokenCatalog(action: HubAction, chainId: number, holdings: HubHoldings): (TokenMetadata & { superseded: boolean })[] {
  const classify = (t: TokenMetadata) => ({ ...t, superseded: isSupersededLegacyPool(t.symbol, chainId) });
  return selectHubTokens(action, {
    actionable: getActionableTokens(chainId).map(classify),
    depositable: getDepositableTokens(chainId).map(classify),
    entrypointDepositable: getEntrypointDepositableTokens(chainId).map(classify),
  }, holdings);
}

/** True for a registry yield share on that chain (ppUSDC, ppUSDT). By address, never by name. */
export function isYieldShareOnChain(address: string, chainId: number): boolean {
  return !!getKnownTokenMetadata(address, chainId)?.yieldShare;
}

/** Metadata for an empty spend form, without restoring a superseded native default. */
export function emptySpendToken(chainId: number): TokenMetadata | undefined {
  return getActionableTokens(chainId).find((t) => !isSupersededLegacyPool(t.symbol, chainId));
}
