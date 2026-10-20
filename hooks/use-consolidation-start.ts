import { useCallback, useEffect, useState } from 'react';
import type { TransferPrefill } from '@/components/transfer-modal-provider';
import { useChainRouter } from '@/hooks/use-chain-router';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useSessionChainId } from '@/hooks/use-session-chain-id';

export type ConsolidationStart = { chainId: number; prefill: TransferPrefill };

/**
 * Starts a consolidation on `chainId`. On another network it switches first and
 * calls `onStart` as soon as that network's keys are derived. The note picker
 * reads the stored notes until the session finishes loading, so it does not
 * wait for that. A declined switch, or a later switch to another network,
 * drops the start.
 */
export function useConsolidationStart(onStart: (prefill: TransferPrefill) => void) {
  const { activeChainId, selectChain } = useChainRouter();
  const sessionChainId = useSessionChainId();
  const { keysReady, keystoreManager } = usePoolSession();
  // `from` is the previous network's key manager: keysReady can still be true
  // for it in the first render on the new network.
  const [pending, setPending] = useState<ConsolidationStart & { from: unknown; switched?: boolean } | null>(null);

  const start = useCallback(async (chainId: number, prefill: TransferPrefill): Promise<'started' | 'switching' | 'declined'> => {
    if (chainId === activeChainId) {
      onStart(prefill);
      return 'started';
    }
    // Updated only while still current: a newer start replaces this one.
    const mine = { chainId, prefill, from: keystoreManager };
    setPending(mine);
    const committed = await selectChain(chainId) === 'committed';
    setPending((current) => current !== mine ? current : committed ? { ...mine, switched: true } : null);
    return committed ? 'switching' : 'declined';
  }, [activeChainId, keystoreManager, onStart, selectChain]);

  useEffect(() => {
    if (!pending) return;
    if (pending.switched && activeChainId !== pending.chainId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the user moved to another network
      setPending(null);
      return;
    }
    if (activeChainId !== pending.chainId || sessionChainId !== pending.chainId
      || !keysReady || !keystoreManager || keystoreManager === pending.from) return;
    setPending(null);
    onStart(pending.prefill);
  }, [pending, activeChainId, sessionChainId, keysReady, keystoreManager, onStart]);

  return { pending, start };
}
