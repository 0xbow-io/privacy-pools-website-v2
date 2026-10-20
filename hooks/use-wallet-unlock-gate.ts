import { useCallback } from 'react';
import { useAccount } from 'wagmi';

import { useToast } from '@/components/toast-provider';
import { usePoolSession } from '@/hooks/use-pool-session';
import { stellarUnlockErrorTitle } from '@/services/stellar/stellar-copy';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useStellarSession } from '@/hooks/use-stellar-session';

/**
 * Shared predicate for the "cached state, no session keys" affordances
 * (My Privacy Pools header, My Transactions row).
 *
 * `requiresWalletUnlock` is true ONLY for a genuinely locked wallet session:
 *  - EVM (the Sui session derives its keys per action),
 *  - identity mode 'wallet' (an account-key identity auto-initializes on
 *    reload — prompting it for a wallet signature would be wrong),
 *  - wagmi status EXACTLY 'connected' (a cached 'reconnecting' address is an
 *    unknown outcome; prompting during hydration or a failed reconnect nags
 *    for a session that may never exist),
 *  - keys unavailable and initialization idle.
 *
 * `keyInitFailed` covers the account-key session whose automatic init
 * errored: the fix is a DIRECT retry (`retryKeyInit`), never the wallet
 * signature prompt.
 *
 * `stellarLocked` is the Stellar counterpart: Freighter connected, keys not
 * derived yet, so the figures are the tab's cached notes and nothing syncs.
 * Its action is `unlockStellar` (one Freighter signature), never the EVM
 * seed-derivation modal.
 */
export function useWalletUnlockGate(): {
  requiresWalletUnlock: boolean;
  keyInitFailed: boolean;
  retryKeyInit: () => void;
  stellarLocked: boolean;
  unlockStellar: () => void;
} {
  const { keysReady, isInitializing, sessionResuming, identityMode, error, ensureInitialized } = usePoolSession();
  const { status } = useAccount();
  const chainRouter = useChainRouter();
  // Non-EVM chain (Sui or Stellar): the EVM-only surfaces below stay off.
  const isSui = chainRouter.isSui || chainRouter.isStellar;

  // A session about to be rebuilt without a prompt (a chain switch after
  // signing in) is not locked: offering Sign in there flashes the dialog.
  const idle = !keysReady && !isInitializing && !sessionResuming;
  const requiresWalletUnlock = !isSui && identityMode === 'wallet' && status === 'connected' && idle;
  const keyInitFailed = !isSui && identityMode === 'key' && idle && !!error;

  const retryKeyInit = useCallback(() => {
    ensureInitialized().catch(() => { /* surfaced via provider error state */ });
  }, [ensureInitialized]);

  const stellar = useStellarSession();
  const stellarLocked = chainRouter.isStellar
    && stellar.wallet.isConnected
    && !stellar.unlocked
    && stellar.status !== 'unlocking';
  const stellarUnlock = stellar.unlock;
  const { toast } = useToast();
  // The session stores the error, but no sign-in surface renders it, so a
  // failed unlock (Freighter on mainnet, a rejected signature) looked like a
  // dead button.
  const unlockStellar = useCallback(() => {
    stellarUnlock().catch((caught: unknown) => {
      toast({ title: stellarUnlockErrorTitle(caught), variant: 'destructive' });
    });
  }, [stellarUnlock, toast]);

  return { requiresWalletUnlock, keyInitFailed, retryKeyInit, stellarLocked, unlockStellar };
}
