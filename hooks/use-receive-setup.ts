import { useCallback, useSyncExternalStore } from 'react';

import { usePoolSession } from '@/hooks/use-pool-session';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import {
  getReceiveSetup,
  partialReceiveChains,
  receiveSetupFromIdentity,
  receiveSetupVersion,
  setReceiveSetup,
  subscribeReceiveSetup,
  type ReceiveSetupState,
} from '@/services/receive-setup';

/**
 * Receive setup for the active chain (or `chainId`). Never reads the chain by
 * itself: each read names this address to that chain's RPC.
 */
export function useReceiveSetup(chainId?: number) {
  const { sessionAddress, identityMode, keysReady, keystoreStatusForChain } = usePoolSession();
  const activeChainId = useActiveEvmChain().id;
  const targetChainId = chainId ?? activeChainId;
  useSyncExternalStore(subscribeReceiveSetup, receiveSetupVersion, receiveSetupVersion);

  const state: ReceiveSetupState = keysReady ? getReceiveSetup(sessionAddress, targetChainId) : 'unknown';
  const partialChains = keysReady ? partialReceiveChains(sessionAddress) : [];

  const refresh = useCallback(async (id: number = targetChainId): Promise<ReceiveSetupState> => {
    const status = await keystoreStatusForChain(id);
    const next = receiveSetupFromIdentity(status);
    setReceiveSetup(sessionAddress, id, next, 'onchain');
    return next;
  }, [keystoreStatusForChain, sessionAddress, targetChainId]);

  return {
    state,
    partial: state === 'partial',
    partialChains,
    /** An account key has no wallet to send `setViewingKey` from. */
    canFinish: identityMode === 'wallet',
    refresh,
  };
}
