import { useEffect, useEffectEvent, useRef } from 'react';
import { useWalletConnectModal } from '@/components/wallet-connect-modal-provider';
import { useStellarWallet } from '@/components/stellar-wallet-provider';

/** Resume an explicit link action once, after its wallet picker connects. */
export function useStellarConnectAction(link: string, action: () => void) {
  const { open, isOpen } = useWalletConnectModal();
  const { isConnected } = useStellarWallet();
  const pendingLink = useRef<string | null>(null);
  const resume = useEffectEvent(action);

  useEffect(() => {
    if (pendingLink.current !== link) {
      pendingLink.current = null;
      return;
    }
    if (isOpen) return;
    pendingLink.current = null;
    if (isConnected) resume();
  }, [link, isOpen, isConnected]);

  return () => {
    pendingLink.current = link;
    return open();
  };
}
