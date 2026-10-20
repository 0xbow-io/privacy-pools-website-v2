import { useSyncExternalStore } from 'react';

import { subscribeWalletChainExcursion, walletChainExcursionHome } from '@/services/wallet-chain-excursion';

/**
 * The chain the app is pinned to while the wallet is on an excursion, or null.
 * See services/wallet-chain-excursion.ts.
 */
export function useWalletChainExcursionHome(): number | null {
  return useSyncExternalStore(subscribeWalletChainExcursion, walletChainExcursionHome, walletChainExcursionHome);
}
