import { useCallback, useEffect, useRef } from 'react';
import { useAccount, useSwitchChain } from 'wagmi';

import { defaultChainId, isSupportedEvmChainId } from '@/config/chains';
import { useWalletConnectModal } from '@/components/wallet-connect-modal-provider';

export function useSupportedWalletConnection() {
  // The CONNECTOR's chain, not useChainId(): the wagmi config store only
  // holds configured chains, so the unsupported-chain checks below could
  // never see a wallet parked on a foreign network (same fix as
  // components/supported-chain-guard.tsx). undefined = not connected /
  // connector still resolving — treated as "nothing to switch".
  const { isConnected, chainId: connectorChainId } = useAccount();
  const chainId = connectorChainId ?? defaultChainId;
  const { switchChainAsync } = useSwitchChain();
  const { open: openWalletPicker } = useWalletConnectModal();
  const lastPromptedChainId = useRef<number | null>(null);
  const switchInFlightRef = useRef(false);

  const requestSupportedChain = useCallback(async (unsupportedChainId: number) => {
    if (switchInFlightRef.current) return false;
    if (lastPromptedChainId.current === unsupportedChainId) return false;

    switchInFlightRef.current = true;
    lastPromptedChainId.current = unsupportedChainId;

    try {
      await switchChainAsync({ chainId: defaultChainId });
      return true;
    } catch {
      lastPromptedChainId.current = null;
      return false;
    } finally {
      switchInFlightRef.current = false;
    }
  }, [switchChainAsync]);

  // Reset the retry latch when the situation resolves. The AUTOMATIC switch
  // prompt lives ONLY in components/supported-chain-guard.tsx (the single
  // global owner) — this hook used to run its own auto-switch effect too, so
  // one unsupported connect fired concurrent wallet_switchEthereumChain
  // prompts from every mounted consumer (header + guard at minimum). This
  // hook now only handles the EXPLICIT retry path (connectWallet below).
  useEffect(() => {
    if (!isConnected || isSupportedEvmChainId(chainId)) {
      lastPromptedChainId.current = null;
    }
  }, [chainId, isConnected]);

  const connectWallet = useCallback(async () => {
    // Already connected but on the wrong chain → just prompt the switch.
    // The modal isn't useful here because the wallet is already picked.
    if (isConnected && !isSupportedEvmChainId(chainId)) {
      await requestSupportedChain(chainId);
      return;
    }

    // Hand off to the wallet picker modal — it owns connector selection
    // (injected vs WalletConnect) + the actual connectAsync call. The
    // post-connect chain check happens via the useEffect below when
    // wagmi's `chainId` updates.
    await openWalletPicker();
  }, [chainId, isConnected, openWalletPicker, requestSupportedChain]);

  return { connectWallet };
}
