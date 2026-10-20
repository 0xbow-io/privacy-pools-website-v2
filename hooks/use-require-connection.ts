import { useCallback } from 'react';
import { useAccount } from 'wagmi';

import { useWalletConnectModal } from '@/components/wallet-connect-modal-provider';
import { usePoolSession } from '@/hooks/use-pool-session';

/**
 * Gate a money-modal open behind wallet connection.
 *
 * Returns `ensureConnected()`: if a wallet is connected it returns `true` and
 * the caller proceeds to open its modal; otherwise it opens the wallet picker
 * and returns `false` so the caller bails out instead of showing a modal that
 * can't be used. This centralizes the rule the pool pages applied ad-hoc via
 * `gated()` so every entry point (home, all-pools, portfolio, payroll, …)
 * behaves the same — no dead modals, no close→connect-prompt loop (QA-4).
 *
 * `allowAccountKey`: relayed flows (withdraw, transfer, payment requests)
 * never post a wallet transaction, so a wallet-less account-key session is
 * sufficient — pass true to let it through. Deposits and ragequits DO post
 * from the user's wallet, so they keep the default (wallet required).
 *
 * Must be used under `WalletConnectModalProvider` (all the modal providers are).
 */
export function useRequireConnection(options?: { allowAccountKey?: boolean }): () => boolean {
  const { isConnected } = useAccount();
  const { identityMode } = usePoolSession();
  const { open: openWalletPicker } = useWalletConnectModal();
  const allowAccountKey = options?.allowAccountKey ?? false;

  return useCallback((): boolean => {
    if (isConnected) return true;
    if (allowAccountKey && identityMode === 'key') return true;
    void openWalletPicker();
    return false;
  }, [isConnected, allowAccountKey, identityMode, openWalletPicker]);
}
