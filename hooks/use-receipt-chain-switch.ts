import { useCallback, useEffect, useRef, useState } from 'react';
import { useAccount } from 'wagmi';

import { isSupportedEvmChainId } from '@/config/chains';
import { useChainRouter } from '@/hooks/use-chain-router';
import { receiptAutoSwitchKey, receiptSwitchTarget, type ReceiptChain } from '@/services/receipt-chain';

export type ReceiptChainSwitch = {
  /** The chain the page can switch to by itself, or null when it cannot. */
  target: number | null;
  /** A switch is in flight (the wallet may be showing its prompt). */
  switching: boolean;
  /** One tap retry, for when the wallet declined or could not switch. */
  switchNow: () => void;
};

/**
 * Put the app on a receipt or claim link's chain instead of asking the user to
 * (a user in the public group: "all popular wallets support auto-network
 * switching"). Uses the network picker's own `selectChain`, so it asks a
 * connected wallet exactly as the picker does and adds the chain to a wallet
 * that does not know it yet. Nothing here reads the link's notes, and the only
 * requests it causes are the ones any chain switch causes.
 *
 * Tried once per chain and connection state (receiptAutoSwitchKey). A declined
 * prompt is not repeated; the page shows a Switch button instead.
 */
export function useReceiptChainSwitch(args: {
  linkChainId: number | undefined;
  sessionChainId: number;
  chain: ReceiptChain;
  /** Hold off while the page is busy with the link (an import in flight). */
  paused?: boolean;
}): ReceiptChainSwitch {
  const { linkChainId, sessionChainId, chain, paused = false } = args;
  const { selectChain } = useChainRouter();
  const { status } = useAccount();
  const [switching, setSwitching] = useState(false);
  const attemptedRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  const target = receiptSwitchTarget({ linkChainId, sessionChainId, chain, selectable: isSupportedEvmChainId });

  const run = useCallback(async (chainId: number) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSwitching(true);
    try {
      await selectChain(chainId);
    } finally {
      inFlightRef.current = false;
      setSwitching(false);
    }
  }, [selectChain]);

  const connection = status === 'connected' ? 'connected'
    : status === 'disconnected' ? 'disconnected'
    : 'pending';
  const key = receiptAutoSwitchKey(target, connection);

  useEffect(() => {
    if (paused || key === null || target === null) return;
    if (attemptedRef.current === key) return;
    attemptedRef.current = key;
    void run(target);
  }, [key, target, paused, run]);

  const switchNow = useCallback(() => {
    if (target !== null) void run(target);
  }, [target, run]);

  return { target, switching, switchNow };
}
