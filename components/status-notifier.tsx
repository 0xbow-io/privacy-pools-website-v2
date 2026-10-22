import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { envScopedStorageKey } from '@/config/app-environment';

import { usePools } from '@/components/pools-provider';
import { useToast } from '@/components/toast-provider';
import { useNotes } from '@/hooks/use-notes';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useBalanceDisplay } from '@/hooks/use-balance-display';
import { depositTransitionTxs, detectStatusTransitions } from '@/services/notification-transitions';

/**
 * Headless: watches the ACTIVE ACCOUNT's deposits and pops a toast the moment
 * one transitions from pending to settled (approved by the ASP) or declined.
 * This is the one async event the user waits on after the flow ends;
 * withdraw/transfer settle synchronously in-flow (their success screen is the
 * feedback), so they get no toast.
 *
 * Identity, not payer: notifications are scoped to a LOGICAL identity —
 * active chain + identity mode + session/wallet address. In key mode the
 * connected wallet is only the payer, so ownership comes from the account's
 * own notes (deposit tx hashes), never the payer address; wallet mode (EVM or
 * Sui) matches the depositing address. Transition memory resets whenever the
 * logical identity changes so one identity's history can't notify under
 * another.
 *
 * The baseline is whatever is on screen when this mounts (re-seeded on
 * identity change), so a fresh load never replays history as a burst — only
 * transitions observed live during the session fire a toast.
 */
// Persisted per-identity transition memory. Without it every (re)connect
// re-seeded from scratch while deposit rows first render with the DEFAULT
// 'pending' review status and flip to approved as ASP data loads — a fake
// pending→approved transition that re-toasted the same deposits on every
// connect. localStorage: a transition notifies once, ever, per identity.
// Environment-scoped: the dev and prod ASPs can serve the same owner and chain
// (codex, 2026-09-02).
const SEEN_STORAGE_KEY = envScopedStorageKey('ppv2_status_notifier_seen_v1');

function loadSeenStatuses(identity: string): Record<string, string> {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return {};
  try {
    const all = JSON.parse(window.localStorage.getItem(SEEN_STORAGE_KEY) ?? '{}') as Record<string, Record<string, string>>;
    return all[identity] ?? {};
  } catch {
    return {};
  }
}

function saveSeenStatuses(identity: string, map: Record<string, string>): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  try {
    const all = JSON.parse(window.localStorage.getItem(SEEN_STORAGE_KEY) ?? '{}') as Record<string, Record<string, string>>;
    all[identity] = map;
    window.localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable — the in-memory ref still dedups this session.
  }
}

export function StatusNotifier(): null {
  const { data } = usePools();
  const { notes } = useNotes();
  const { toast } = useToast();
  const { identityMode, sessionAddress } = usePoolSession();
  const { address: walletAddress } = useMultiChainWallet();
  const { activeChainId } = useChainRouter();
  const balanceDisplay = useBalanceDisplay(activeChainId);

  // The logical notification identity. Any change fully re-seeds the memory.
  const identityKey = `${activeChainId}|${identityMode ?? 'none'}|${(sessionAddress ?? walletAddress ?? '').toLowerCase()}`;

  const prevStatuses = useRef<Record<string, string>>(loadSeenStatuses(identityKey));
  const prevIdentity = useRef(identityKey);

  useEffect(() => {
    // Re-seed on identity change so one identity's history can't notify under
    // another. Done inside the effect (never during render).
    if (identityKey !== prevIdentity.current) {
      prevIdentity.current = identityKey;
      prevStatuses.current = loadSeenStatuses(identityKey);
    }
    if (identityMode == null && !walletAddress) {
      return;
    }
    // Ownership signal per identity mode:
    //  - wallet mode (EVM or Sui): the depositing address is the account;
    //  - key mode: the wallet is only the payer — a deposit is the account's
    //    iff the account owns a note created by that tx.
    const addrLc = identityMode === 'key'
      ? null
      : (walletAddress ?? sessionAddress ?? '').toLowerCase() || null;
    const noteTxHashes = identityMode === 'key'
      ? new Set(notes.map((n) => String(n.txHash || '').toLowerCase()).filter(Boolean))
      : null;

    const input = depositTransitionTxs(data.transactions, (tx) => (noteTxHashes
      ? noteTxHashes.has(tx.txHash.toLowerCase())
      : !!addrLc && !!tx.fullAddress && tx.fullAddress.toLowerCase() === addrLc));
    const { events, next } = detectStatusTransitions(prevStatuses.current, input, (tx) => {
      // Toast copy only: the grid-backed rate converts the displayed quantity,
      // never the activity row or any operational amount.
      const view = balanceDisplay(tx.tokenAmount, tx.asset, tx.chainId, tx.tokenAddress);
      return `${view.converted ? '≈ ' : ''}${view.text}`;
    });
    prevStatuses.current = next;
    saveSeenStatuses(identityKey, next);
    for (const event of events) {
      // Deposits only — the async approval/rejection. A toast for a
      // synchronous withdraw/transfer completion would just double the
      // success screen the user is already looking at.
      if (event.baseType !== 'Deposit') continue;
      toast({ title: event.title, description: event.description, variant: event.variant });
    }
  }, [identityKey, identityMode, sessionAddress, walletAddress, notes, data.transactions, balanceDisplay, toast]);

  return null;
}
