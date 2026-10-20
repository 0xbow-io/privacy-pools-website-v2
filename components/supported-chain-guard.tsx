import { useEffect, useRef, useState } from 'react';
import { useAccount, useSwitchChain } from 'wagmi';

import { defaultChainId, isSupportedEvmChainId } from '@/config/chains';

// Native has no document: always "active" there. Visible AND focused: two
// windows side by side are both visible, so visibility alone let the unfocused
// one still move the wallet.
function isTabVisible(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden' && document.hasFocus();
}

export function SupportedChainGuard() {
  // The CONNECTOR's chain, not useChainId(): the wagmi config store only ever
  // holds a configured chain, so `isSupportedEvmChainId(store)` was always
  // true and this guard could never fire — a wallet parked on an unsupported
  // network sailed straight past it. useAccount().chainId reports the
  // wallet's actual chain, including ids this build has never heard of.
  const { isConnected, chainId } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const lastPromptedChainId = useRef<number | null>(null);
  // STATE, not a ref: when a switch settles the effect must re-run and look
  // at the CURRENT connector chain. With a ref, a wallet that moved from
  // unsupported U to unsupported V while the U prompt was pending returned
  // early on the in-flight check, and `.finally` mutating the ref caused no
  // re-render — V stayed unsupported with automatic handling wedged off.
  const [switchInFlight, setSwitchInFlight] = useState(false);
  // Only the tab the user is looking at may move the wallet. MetaMask keeps one
  // network per SITE, so every other open tab sees the same chain change, and
  // a tab whose build does not know the new chain (prod has no OP, plain
  // staging hides it) switched the wallet straight back to its own default:
  // OP on staging-mainnet "kept flipping back" to Ethereum or Sepolia (Mike,
  // 2026-09-28). A hidden or unfocused tab re-checks when it comes back.
  const [tabVisible, setTabVisible] = useState(() => isTabVisible());
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onChange = () => setTabVisible(isTabVisible());
    document.addEventListener('visibilitychange', onChange);
    window.addEventListener('focus', onChange);
    window.addEventListener('blur', onChange);
    return () => {
      document.removeEventListener('visibilitychange', onChange);
      window.removeEventListener('focus', onChange);
      window.removeEventListener('blur', onChange);
    };
  }, []);

  useEffect(() => {
    if (!isConnected || chainId === undefined) {
      lastPromptedChainId.current = null;
      return;
    }

    if (isSupportedEvmChainId(chainId)) {
      lastPromptedChainId.current = null;
      return;
    }

    if (!tabVisible) {
      return;
    }

    if (lastPromptedChainId.current === chainId) {
      return;
    }

    if (switchInFlight) {
      return;
    }

    setSwitchInFlight(true);
    lastPromptedChainId.current = chainId;

    switchChainAsync({ chainId: defaultChainId })
      .catch(() => {
        // Rejected: don't immediately re-prompt for the SAME chain (the latch
        // above holds), but a move to a different unsupported chain re-fires
        // via the state flip below.
      })
      .finally(() => {
        setSwitchInFlight(false);
      });
  }, [chainId, isConnected, switchInFlight, switchChainAsync, tabVisible]);

  return null;
}
