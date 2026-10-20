import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useChainRouter } from '@/hooks/use-chain-router';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useSuiSession } from '@/hooks/use-sui-session';
import { useStellarSession } from '@/hooks/use-stellar-session';
import { invalidateTransactionCaches } from '@/services/cache';
import { useToast } from '@/components/toast-provider';
import { stellarUnlockErrorTitle } from '@/services/stellar/stellar-copy';

/**
 * "Refresh everything", shared by every surface that offers one.
 *
 * Extracted from the header's ↻ button so a second entry point cannot drift
 * from it. That drift is not hypothetical: the Sui branch always invalidated
 * the react-query caches after discovery and the EVM branch did not, so the
 * button did its work and the screen never changed (QA 2026-08-18). A copy of
 * this in the mobile balances sheet would have been the next place to lose a
 * branch.
 *
 * `syncing` is true for whichever branch is running, so a caller can disable
 * its control without tracking which chain type is active.
 *
 * It runs only when the user presses it, never after a transaction. On EVM it
 * is a discovery sweep, and discovery reads its ASP data from what the feed
 * grid holds (services/sdk-setup.ts), so the press reaches the RPC provider
 * and not the ASP.
 */
/**
 * The refresh in flight, shared by EVERY instance of the hook. `syncing` is
 * render-time state, so two taps in one tick (or the header and the mobile
 * sheet pressed together) would both pass the disabled check and launch two
 * all-chain sweeps. Module-level so the second caller joins the first instead.
 */
let inFlight: Promise<void> | null = null;

export function useSyncEverything(): { sync: () => Promise<void>; syncing: boolean } {
  const queryClient = useQueryClient();
  const { syncAllChains, isSyncing } = usePoolSession();
  const suiSession = useSuiSession();
  // The ACTIVE chain selection, matching the header: the sync branch has to
  // follow what the user is looking at, not what a wallet happens to be on.
  const { isSui: activeIsSui, isStellar: activeIsStellar } = useChainRouter();
  const stellarSession = useStellarSession();
  const [suiSyncing, setSuiSyncing] = useState(false);
  const { toast } = useToast();

  const run = useCallback(async () => {
    if (activeIsStellar) {
      // Stellar notes live in the shared Stellar account; a manual sync is an
      // explicit action, so it may ask for the one-time unlock signature.
      setSuiSyncing(true);
      try {
        await stellarSession.unlock();
      } catch (caught) {
        // The session records the error, but nothing near this button renders
        // it: without the toast a failed sync looked like a dead button.
        toast({ title: stellarUnlockErrorTitle(caught), variant: 'destructive' });
      } finally {
        setSuiSyncing(false);
      }
      return;
    }
    if (activeIsSui) {
      // The EVM SDK's snapshot discovery never touches the Sui note store, so
      // on Sui this has to route to Sui discovery or the pools/transactions
      // views stay stale.
      setSuiSyncing(true);
      try {
        await suiSession.scanForNotes();
        await invalidateTransactionCaches(queryClient);
      } catch {
        /* discovery errors surface via the Sui session; a manual retry is safe */
      } finally {
        setSuiSyncing(false);
      }
      return;
    }
    try {
      // ALL chains, not just the active one: balances and the transactions
      // table are multichain, so syncing only the active chain left the other
      // chains' rows exactly as stale as the button appeared to be (Pat,
      // 2026-08-18, after a cross-chain shield into Optimism).
      await syncAllChains();
    } finally {
      // Discovery alone only updates the SDK's note store; the views render
      // from react-query.
      await invalidateTransactionCaches(queryClient);
    }
  }, [activeIsSui, activeIsStellar, stellarSession, suiSession, queryClient, syncAllChains, toast]);

  const sync = useCallback(() => {
    if (!inFlight) {
      inFlight = run().finally(() => { inFlight = null; });
    }
    return inFlight;
  }, [run]);

  return { sync, syncing: isSyncing || suiSyncing };
}
