import { getChainConfig, isChainSelectable, STELLAR_TESTNET_ID } from '@/config/chains';
import { STELLAR_TESTNET_CONTRACTS, STELLAR_XLM } from '@/config/stellar-deployment';
import type { ShieldPool } from '@/services/shield-pools';

/** Direct XLM flows only. Never add this directory to conversion route discovery. */
export function stellarWidgetPools(): ShieldPool[] {
  const chain = getChainConfig(STELLAR_TESTNET_ID);
  if (!chain || !isChainSelectable(chain.id, false)) return [];
  return [{ chainId: chain.id, chainName: chain.displayName, symbol: STELLAR_XLM.symbol,
    address: STELLAR_TESTNET_CONTRACTS.nativeAssetContractId, decimals: STELLAR_XLM.decimals }];
}
