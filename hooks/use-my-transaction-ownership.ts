// ONE answer to "is this activity row mine?", shared by every mine-scoped
// surface: the My Transactions table, the home latest-activity line and the
// notification bell. The table had the only complete answer (notes on every
// chain claim rows by tx hash OR label, deposits fall back to the identity's
// address, deposits this wallet made FOR someone else are authorship, not
// ownership); the two previews filtered by wallet address alone, so a row the
// table showed could vanish from them at the ASP handoff, and a key session
// (no wallet address) saw nothing (codex, 2026-09-04).
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useNotes } from '@/hooks/use-notes';
import { getChainConfig, supportedChainIds } from '@/config/chains';
import { loadStoredAccountExport } from '@/components/sdk-provider';
import { usePools, type PoolsData, type Transaction } from '@/components/pools-provider';
import { noteIdentitySets, depositMatchesMyNotes, normalizeCommitment } from '@/services/deposit-ownership';
import { mergeNotesByCommitment } from '@/services/note-sets';
import { useLiveNotesChainId } from '@/hooks/use-live-notes-chain-id';
import {
  buildOutgoingDepositTxHashSet,
  getOutgoingDepositsVersion,
  subscribeOutgoingDeposits,
} from '@/services/outgoing-deposits-store';
import { buildSentTxHashSet } from '@/services/sent-transfers-store';
import { findPaidRequest } from '@/services/paid-requests-store';
import { isHeldForSpendClassification, isInternalSpendRow, isOwnSwapChangeRow } from '@/services/transfer-direction';

export function useMyTransactionOwnership() {
  const { notes } = useNotes();
  // Chain-aware connection: wagmi's address is empty when a Sui wallet drives
  // the session.
  const { address: connectedAddress } = useMultiChainWallet();
  // The identity whose STORED note export is read. Balances use exactly this
  // precedence; a key session has no wallet address (Pat, 2026-09-01).
  const { sessionAddress, identityMode } = usePoolSession();
  const exportIdentity = sessionAddress ?? connectedAddress;
  // The identity a DEPOSIT row is matched against when note-matching does not
  // resolve it. BRANCHED on identityMode, not `wallet ?? session`: a key
  // session can have a funding wallet connected at a DIFFERENT address, and
  // that payer must not claim the key account's rows, nor lend its own. The
  // non-key branch keeps the wallet address, so Sui is untouched.
  const ownAddress = identityMode === 'key' ? (sessionAddress ?? connectedAddress) : connectedAddress;

  // My notes on EVERY chain, not just the live session's: a cross-chain shield
  // mints its note in the destination chain's bucket, and the row for it is
  // deposited by LiFi's executor, so only that note can claim it.
  const allOwnedNotes = useMemo(() => {
    if (!exportIdentity) return notes;
    const extra: typeof notes = [];
    for (const cid of supportedChainIds) {
      if (getChainConfig(cid)?.chainType !== 'evm') continue;
      for (const n of loadStoredAccountExport(exportIdentity, cid)?.notes ?? []) extra.push(n as unknown as (typeof notes)[number]);
    }
    const all = extra.length ? [...notes, ...extra] : notes;
    // Compare a wallet session against an account-key one: which identity was
    // used, and how many notes each source contributed. Same `ppv2_debug`
    // switch as the panel (Pat, 2026-09-01).
    if (Platform.OS === 'web') {
      try {
        if (localStorage.getItem('ppv2_debug') === '1') {
          console.log('[notes] table assembled', {
            exportIdentity,
            walletAddress: connectedAddress ?? null,
            sessionAddress: sessionAddress ?? null,
            liveNotes: notes.length,
            storedNotes: extra.length,
            total: all.length,
          });
        }
      } catch { /* storage unavailable */ }
    }
    return all;
  }, [notes, exportIdentity, connectedAddress, sessionAddress]);
  // The same notes, by the chain that holds them: the session's live notes
  // first (the fresher status), then that chain's stored copy, each commitment
  // once. A row's per-note state (fully spent, its proof) is read from its own
  // chain's notes, never from whichever chain is selected.
  const liveChainId = useLiveNotesChainId();
  const notesByChain = useMemo(() => {
    const map = new Map<number, typeof notes>();
    if (exportIdentity) {
      for (const cid of supportedChainIds) {
        if (getChainConfig(cid)?.chainType !== 'evm') continue;
        const stored = (loadStoredAccountExport(exportIdentity, cid)?.notes ?? []) as unknown as typeof notes;
        if (stored.length > 0) map.set(cid, stored);
      }
    }
    if (liveChainId !== null) map.set(liveChainId, mergeNotesByCommitment(notes, [map.get(liveChainId) ?? []]));
    return map;
  }, [notes, exportIdentity, liveChainId]);
  const ownedIdentity = useMemo(() => noteIdentitySets(allOwnedNotes), [allOwnedNotes]);
  const noteLabels = ownedIdentity.labels;

  // Deliberately every chain's notes (see allOwnedNotes): a received
  // transfer's or a deposit's identity lives wherever its bucket is.
  const noteTxHashes = useMemo(() => {
    const s = new Set<string>();
    for (const n of allOwnedNotes) if (n.txHash) s.add(String(n.txHash).toLowerCase());
    return s;
  }, [allOwnedNotes]);

  // Locally-stamped outgoing transfers: distinguishes the sender's change from
  // a real Transfer In. Re-built when notes change so a fresh send picks it up
  // after the modal updates state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sentTxHashes = useMemo(() => buildSentTxHashSet(), [notes]);

  // Deposits this wallet SUBMITTED for someone else ("Deposit to another
  // address"): authorship, not ownership. Re-read whenever notes change so a
  // stamp written by a deposit in this session is picked up, and whenever the
  // store says it changed, for a stamp written with no note change behind it
  // (the row menu re-stamping a recovered claim link on a fresh browser).
  const outgoingDepositsVersion = useSyncExternalStore(
    subscribeOutgoingDeposits,
    getOutgoingDepositsVersion,
    getOutgoingDepositsVersion,
  );
  const outgoingDepositTxHashes = useMemo(
    () => buildOutgoingDepositTxHashSet(ownAddress ?? null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ownAddress, notes, outgoingDepositsVersion],
  );
  // Signal 3 for this wallet's own submissions (services/deposit-ownership.ts):
  // sealed to another account, or still being decided.
  const { data: { depositOwnership } } = usePools();
  const isDepositMine = useCallback(
    (tx: Transaction) => {
      if (tx.type !== 'Deposit') return false;
      // Claimed by one of my notes (tx hash OR label, any chain): this is
      // what makes a LiFi-executed cross-chain shield mine.
      if (depositMatchesMyNotes({ txHash: tx.txHash ?? null, label: tx.label ?? null, commitment: tx.ownCommitment, tokenAddress: tx.tokenAddress }, ownedIdentity)) return true;
      const hash = tx.txHash?.toLowerCase();
      if (hash && outgoingDepositTxHashes.has(hash)) return false;
      if (hash && (depositOwnership.notMine.has(hash) || depositOwnership.pending.has(hash))) return false;
      return !!ownAddress
        && !!tx.fullAddress
        && tx.fullAddress.toLowerCase() === ownAddress.toLowerCase();
    },
    [ownAddress, ownedIdentity, outgoingDepositTxHashes, depositOwnership],
  );
  /**
   * A deposit THIS wallet submitted for someone else. Authorship, not
   * ownership, and the distinction is load-bearing.
   *
   * `isDepositMine` answers false for these on purpose: the money belongs to
   * the recipient now, so counting it would put it back in the payer's pending
   * balance and deposit counts and re-arm Withdraw and Exit on the row. That
   * stays exactly as it was. This predicate is for DISPLAY only.
   *
   * Why display needs it: the payer's own record of the payment lived only in
   * the protocol-wide All feed, while a connected user defaults to My. For a
   * deposit to someone who never registered, the row menu is where the
   * recipient's one-time claim link is rebuilt - so the one payment whose link
   * the sender is most likely to need again was the one they could not find
   * (Pat, 2026-09-16).
   *
   * Local by construction: the stamp set comes from this device's own record
   * (services/outgoing-deposits-store.ts), and a deposit whose Note payload
   * was sealed to another account (`depositOwnership.notMine`) is decided here
   * from public ciphertexts, so this asks the network nothing and tells the
   * ASP nothing. One still being decided is neither mine nor authored yet. The row itself is an ordinary public deposit
   * made by this wallet's own address, which is on chain either way; all that
   * changes is that we stop hiding it from the person who made it.
   */
  const isDepositAuthoredByMe = useCallback(
    (tx: Transaction) =>
      tx.type === 'Deposit'
      && !!tx.txHash
      && (outgoingDepositTxHashes.has(tx.txHash.toLowerCase()) || depositOwnership.notMine.has(tx.txHash.toLowerCase())),
    [outgoingDepositTxHashes, depositOwnership],
  );
  /**
   * A deposit row whose menu may offer "Recover claim link".
   *
   * `isDepositAuthoredByMe` knows a payment only through this device's stamp,
   * which is exactly what a new browser (or evicted storage) does not have -
   * and recovery on a new browser is the whole point of the on-chain backup
   * (Pat, 2026-09-16). So this also accepts PUBLIC authorship: the row's
   * depositor is this identity's own address (on chain for anyone to read)
   * and none of my notes claims it. My own shields get claimed by a note once
   * discovery has run; a deposit I made for someone else never does, because
   * its note was never mine. Until discovery settles, a fresh own shield can
   * pass too; clicking then finds no backup and says so. Nothing here reads
   * the network, and it gates only the menu item, never a balance or a
   * spending action.
   */
  const isDepositRecoverable = useCallback(
    (tx: Transaction) => {
      if (tx.type !== 'Deposit' || !tx.txHash) return false;
      if (isDepositAuthoredByMe(tx)) return true;
      if (depositMatchesMyNotes({ txHash: tx.txHash, label: tx.label ?? null, commitment: tx.ownCommitment, tokenAddress: tx.tokenAddress }, ownedIdentity)) return false;
      return !!ownAddress
        && !!tx.fullAddress
        && tx.fullAddress.toLowerCase() === ownAddress.toLowerCase();
    },
    [isDepositAuthoredByMe, ownedIdentity, ownAddress],
  );
  const isMine = useCallback((tx: Transaction) => {
    if (tx.type === 'Deposit') return isDepositMine(tx);
    const txHashMatch = !!tx.txHash && noteTxHashes.has(tx.txHash.toLowerCase());
    const labelMatch = !!tx.label && noteLabels.has(normalizeCommitment(tx.label) ?? '');
    return txHashMatch || labelMatch;
  }, [isDepositMine, noteTxHashes, noteLabels]);

  /**
   * The feed rows a mine-scoped surface shows, before the lineage merge:
   * mine, not an internal spend (self merge/split: no lineage row replaces
   * its ASP row, which would then read as a received transfer), and, while my
   * spends are being re-classified for a new snapshot, no Transact row I own
   * only through a note (my own change note would read as Transfer In until
   * the lineage row replaces it, DEV-394). A row this device stamped itself
   * (a send, a paid request) keeps its known direction.
   */
  const filterMineEvents = useCallback(
    (transactions: readonly Transaction[], data: Pick<PoolsData, 'internalTxHashes' | 'spendClassificationPending'>) =>
      transactions.filter(
        // Owned OR authored. Authored rows are shown and nothing more: every
        // ownership-gated surface (balances, counts, and the Withdraw / Exit /
        // Export actions, which recompute isDepositMine for themselves) still
        // answers false for them.
        (tx) => (isMine(tx) || isDepositAuthoredByMe(tx))
          && !isInternalSpendRow(tx, data.internalTxHashes)
          // My swap's source-pool row, owned through its change note: the
          // swap's own row shows it, so it is not a Transfer In (DEV-455).
          && !(isOwnSwapChangeRow(tx, allOwnedNotes) && !sentTxHashes.has(String(tx.txHash || '').toLowerCase()))
          && !isHeldForSpendClassification(tx, {
            pending: data.spendClassificationPending,
            sentTxHashes,
            isPaidRequest: (hash) => !!findPaidRequest(hash),
          }),
      ),
    [isMine, isDepositAuthoredByMe, sentTxHashes, allOwnedNotes],
  );

  return {
    connectedAddress,
    sessionAddress,
    identityMode,
    exportIdentity,
    ownAddress,
    allOwnedNotes,
    notesByChain,
    ownedIdentity,
    noteLabels,
    noteTxHashes,
    sentTxHashes,
    outgoingDepositTxHashes,
    isDepositMine,
    isDepositAuthoredByMe,
    isDepositRecoverable,
    isMine,
    filterMineEvents,
  };
}
