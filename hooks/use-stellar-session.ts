/**
 * Stellar session hook — the Stellar counterpart of hooks/use-sui-session.ts,
 * and the single entry point the flow modals call on the Stellar chain.
 *
 * State lives in the shared `stellarAccount` store (services/stellar/
 * stellar-account.ts), so every modal and the balance views see one account,
 * one note list and one key-derivation signature per page load.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { useStellarWallet } from '@/components/stellar-wallet-provider';
import { stellarAccount, type StellarNote, type StellarRequestState } from '@/services/stellar/stellar-account';
import { NoteStatus } from '@/services/sdk-types';

// Fixed wall-clock grid, never paused or gated on UI state (see
// docs/privacy-request-discipline.md and services/public-feed-scheduler.ts):
// the poll must not mark a transaction or an unlock by starting, stopping or
// changing speed around it.
export const STELLAR_SYNC_INTERVAL_MS = 30_000;

/** Delay to the next grid instant, independent of when this client started. */
export function msUntilNextSyncTick(now: number, intervalMs: number = STELLAR_SYNC_INTERVAL_MS): number {
  return intervalMs - (now % intervalMs);
}

/**
 * Keeps the shared account bound to the connected Stellar wallet and syncs it
 * on a fixed wall-clock grid. The timer runs from mount whatever the user does;
 * a tick is a no-op until the account is unlocked. Mounted once, next to the
 * wallet provider.
 */
export function useStellarAccountBinding() {
  const { address, signer, isConnected } = useStellarWallet();
  useEffect(() => {
    stellarAccount.bind(isConnected ? address : null, isConnected ? signer : null);
  }, [address, signer, isConnected]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => {
        stellarAccount.syncIfUnlocked().catch(() => undefined);
        schedule();
      }, msUntilNextSyncTick(Date.now()));
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
}

export function isStellarNoteSpendable(note: StellarNote): boolean {
  return note.status === NoteStatus.ACTIVE;
}

export function isStellarNoteHeld(note: StellarNote): boolean {
  return note.status === NoteStatus.ACTIVE || note.status === NoteStatus.PENDING;
}

const EMPTY_NOTES: StellarNote[] = [];
const EMPTY_REQUESTS: StellarRequestState[] = [];

// Bound once: callers put these in dependency lists.
const STABLE_ACTIONS = {
  sync: () => stellarAccount.sync(),
  deposit: stellarAccount.deposit.bind(stellarAccount),
  withdraw: stellarAccount.withdraw.bind(stellarAccount),
  transfer: stellarAccount.transfer.bind(stellarAccount),
  ragequit: stellarAccount.ragequit.bind(stellarAccount),
  ensureCanReceive: stellarAccount.ensureCanReceive.bind(stellarAccount),
  createPaymentRequest: stellarAccount.createPaymentRequest.bind(stellarAccount),
  payPaymentRequest: stellarAccount.payPaymentRequest.bind(stellarAccount),
  exportBackup: stellarAccount.exportBackup.bind(stellarAccount),
  importBackup: stellarAccount.importBackup.bind(stellarAccount),
  recordRequestRow: stellarAccount.recordRequestRow.bind(stellarAccount),
  exportRequestBackup: stellarAccount.exportRequestBackup.bind(stellarAccount),
  markRequestBackupSaved: stellarAccount.markRequestBackupSaved.bind(stellarAccount),
  importRequestBackup: stellarAccount.importRequestBackup.bind(stellarAccount),
  sendOneTime: stellarAccount.sendOneTime.bind(stellarAccount),
  claim: stellarAccount.claim.bind(stellarAccount),
  keepClaim: stellarAccount.keepClaim.bind(stellarAccount),
  retryPendingLabels: stellarAccount.retryPendingLabels.bind(stellarAccount),
};

export function useStellarSession() {
  const wallet = useStellarWallet();
  const snapshot = useSyncExternalStore(stellarAccount.subscribe, stellarAccount.getSnapshot, stellarAccount.getSnapshot);

  /**
   * Explicit user action (Sync / Sign in): unlock if needed, sync, and re-send
   * any ASP registration a deposit left behind. A failed registration is
   * recorded on the session error and rethrown, never swallowed.
   */
  const unlock = useCallback(async () => {
    await stellarAccount.ensureSession();
    await stellarAccount.sync();
    const { sent, failed, firstError } = await stellarAccount.retryPendingLabels();
    if (sent > 0) await stellarAccount.sync();
    if (failed > 0) throw new Error(firstError ?? 'An ASP registration did not go through.');
  }, []);

  // Derived once per store snapshot. These arrays feed useNotes and the modal
  // memos on EVERY chain, so a fresh array per render would re-run every
  // notes-keyed effect in the app on every render.
  // The store switches accounts in a passive effect, so for one render after a
  // Freighter account change it still holds the previous account's notes.
  // Show nothing until the store and the wallet agree.
  const walletAddress = wallet.isConnected ? wallet.address ?? null : null;
  const storeMatchesWallet = snapshot.address === walletAddress;
  const snapshotNotes = storeMatchesWallet ? snapshot.notes : EMPTY_NOTES;
  const derived = useMemo(() => {
    const ownNotes = snapshotNotes.filter((note) => note.isOwned !== false);
    const spendableNotes = ownNotes.filter(isStellarNoteSpendable);
    const pendingNotes = ownNotes.filter((note) => note.status === NoteStatus.PENDING);
    return {
      ownNotes,
      spendableNotes,
      pendingNotes,
      spendableTotal: spendableNotes.reduce((sum, note) => sum + BigInt(note.value), 0n),
      pendingTotal: pendingNotes.reduce((sum, note) => sum + BigInt(note.value), 0n),
    };
  }, [snapshotNotes]);
  const { ownNotes, spendableNotes, pendingNotes, spendableTotal, pendingTotal } = derived;

  return {
    wallet,
    address: snapshot.address,
    status: snapshot.status,
    unlocked: snapshot.unlocked,
    registered: snapshot.registered,
    // Same account guard as the notes: never pair one account's notes with another's index.
    noteOrigins: storeMatchesWallet ? snapshot.noteOrigins : null,
    /** This account's blind payment requests and whether each was paid. */
    paymentRequests: storeMatchesWallet ? snapshot.paymentRequests : EMPTY_REQUESTS,
    error: snapshot.error,
    lastSyncedAt: snapshot.lastSyncedAt,
    notes: ownNotes,
    spendableNotes,
    pendingNotes,
    spendableTotal,
    pendingTotal,
    unlock,
    ...STABLE_ACTIONS,
  };
}

export type StellarSession = ReturnType<typeof useStellarSession>;
