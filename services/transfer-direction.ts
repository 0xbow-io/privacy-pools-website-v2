import type { Note } from '@/services/sdk-types';
import type { Transaction } from '@/components/pools-provider';
import { withoutFoldedSwapOutputs, withSwapRows } from '@/services/swap-rows';

/**
 * Merges the connected user's own ASP event rows with the reconstructed
 * lineage rows for the "My Transactions" scope (#215).
 *
 * Reconstructed rows share a txHash with the ASP event row for the same tx, and
 * the reconstructed one is the one that knows the direction: a spend's ASP row
 * is misdirected on a device with no local sent-stamp (classifyTransfer sees
 * the sender's change note and renders it as "Transfer In"), and a receipt's
 * ASP row on another chain than the session's has no notes to decode it with
 * at all ("Transfer · Private"). So we DROP any ASP row whose txHash a lineage
 * row already covers and keep the reconstructed row. Sorted newest-first.
 */
export function mergeMyTransactions(
  eventRowsMine: Transaction[],
  lineageRows: Transaction[],
  /**
   * Tx hashes this device recorded as MY OWN confirmed anchors
   * (services/anchor-stamps-store.ts). Their feed rows are dropped even when no
   * lineage row exists yet.
   *
   * Why the lineage check alone is not enough: the activity feed and the event
   * snapshot are different ASP endpoints with different lag. Right after a
   * claim the feed already carries the anchor while the snapshot - which is
   * what reconstructUserSpends reads - does not, so for a minute or two there
   * is no lineage row to suppress against and the user's own anchor output
   * rendered as an incoming payment they never received (Pat, 2026-09-01,
   * keystoreless run). The stamp is written locally the instant the claim
   * confirms, so it closes that window without guessing at a delay.
   */
  ownAnchorTxHashes: ReadonlySet<string> = new Set(),
): Transaction[] {
  // Only SPEND lineage rows replace feed rows: a synthesized own Deposit (the
  // destination side of a cross-chain swap carries the SOURCE tx hash) must not
  // swallow the Withdrawal / Transfer row of that same hash (codex, 2026-09-04).
  const lineageTxHashes = new Set(
    lineageRows.filter((tx) => tx.type !== 'Deposit').map((tx) => String(tx.txHash || '').toLowerCase()).filter(Boolean),
  );
  // A lineage row replaces the feed's WITHDRAWAL/TRANSFER row for that spend.
  // It never stands for a deposit: a reshield spends my notes and re-deposits
  // the swapped value in the SAME tx, so the feed carries a Deposit row with
  // the spend's tx hash, and dropping every row by tx hash swallowed it (Pat,
  // 2026-08-30: the 0.95 USDT deposit of a reshield showed in All, not Mine).
  const keptEventRows = eventRowsMine.filter((tx) => {
    if (tx.type === 'Deposit') return true;
    const hash = String(tx.txHash || '').toLowerCase();
    if (!hash) return true;
    // My own confirmed anchor: never a received payment, whatever the feed says
    // and whether or not the lineage row has caught up.
    if (ownAnchorTxHashes.has(hash)) return false;
    return !lineageTxHashes.has(hash);
  });
  // A Swap row is the swap's spend AND its output: the output's Deposit rows,
  // from the feed or synthesized from the note, fold into it.
  return withoutFoldedSwapOutputs([...keptEventRows, ...lineageRows], lineageRows)
    .sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * The All tab's rows, with each feed Transfer row a lineage row covers swapped
 * for that lineage row. The lineage row carries the direction and amount from
 * every chain's notes; the feed row has only the session chain's to go on, so
 * my own transfer on another chain read "Private" there, and my consolidation
 * read as a receipt of its own output. The feed guesses Transfer from output
 * arity, so a lineage Withdrawal replaces it too: my mixed-label withdrawal
 * leaves one change note per label and read as a stranger's private transfer.
 * Rows of strangers have no lineage row and stay as they are, and so do all
 * the Transfer rows of a batch tx.
 */
export function withLineageTransfers(eventRows: Transaction[], lineageRows: readonly Transaction[]): Transaction[] {
  // My own swaps likewise take the place of the feed rows they explain
  // (services/swap-rows.ts); strangers' rows are untouched.
  const rows = withSwapRows(eventRows, lineageRows);
  const byTx = new Map<string, Transaction>();
  for (const row of lineageRows) {
    const key = String(row.txHash || '').toLowerCase();
    if ((row.type === 'Transfer' || row.type === 'Withdrawal') && key && !byTx.has(key)) byTx.set(key, row);
  }
  if (byTx.size === 0) return rows;
  // Only where the feed has exactly one Transfer for the tx: nothing tells
  // which row of a batch tx is mine (as withWithdrawalDecorations).
  const counts = new Map<string, number>();
  for (const tx of rows) {
    const key = String(tx.txHash || '').toLowerCase();
    if (tx.type === 'Transfer') counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return rows.map((tx) => {
    const key = String(tx.txHash || '').toLowerCase();
    return (tx.type === 'Transfer' && counts.get(key) === 1 && byTx.get(key)) || tx;
  });
}

/**
 * Classifies a Transfer transaction's direction relative to the
 * connected user's owned notes. Returns:
 *   'out' — user spent input notes in this tx (sender)
 *   'in'  — user received an output note in this tx (recipient)
 *   null  — not a transfer, or no relevant notes for this user
 *
 * Sender vs recipient looks symmetric on-chain — both sides own a
 * Note created in the same transact tx — so we can't distinguish
 * them from the SDK's note state alone:
 *
 *  • The ASP's transfer events don't always carry a `label`, so a
 *    label-based heuristic is unreliable.
 *  • `Note.spentAtBlock` is the block *number*, not a timestamp, so
 *    it can't be matched against the ASP's `event.timestamp` without
 *    an extra RPC roundtrip per row.
 *
 * Instead we lean on a per-device local stamp written when the user
 * initiates a transfer (transfer-modal-provider →
 * sent-transfers-store). Pass that set of txHashes through
 * `sentTxHashes` and we'll classify those rows as 'out'.
 *
 * Without a sender stamp, we fall through to the recipient signal:
 * any note we own that was emitted by this tx → 'in'. SPENT notes are
 * included: a transfer you received and later spent is still a received
 * transfer in your history, and its (now-spent) note is the only signal that
 * decodes the row as 'in'. Excluding spent notes here — while the activity
 * feed's ownership filter (isMine in transactions.tsx) includes them — left a
 * received-then-spent transfer stuck as an undecodable "Transfer · ?".
 * Outgoing sends are already caught by the sent-stamp above, and cross-device
 * sends by the reconstructed lineage row that replaces this ASP row (see
 * mergeMyTransactions), so matching a spent note here won't mislabel a send.
 */
/**
 * A note can only explain a row of its own token. A reshield (private swap)
 * spends a source note and deposits the OUTPUT note in the same tx, so a
 * hash-only match read the swap's source-pool row as "Transfer In" with the
 * output note's amount under the source symbol (DEV-455: 15.2495 FDUSD shown
 * as 15.2495 BNB). Unknown or non-EVM on either side is not a mismatch.
 */
export function sameToken(tx: Transaction, note: Note): boolean {
  const rowToken = String(tx.tokenAddress || '').toLowerCase();
  const noteToken = String(note.tokenId || '').toLowerCase();
  // EVM asset addresses only: Sui note tokenIds are random ids, not the asset,
  // so they can never be compared this way (review).
  const evm = /^0x[0-9a-f]{40}$/;
  if (!evm.test(rowToken) || !evm.test(noteToken)) return true;
  return rowToken === noteToken;
}

export function classifyTransfer(
  tx: Transaction,
  notes: Note[],
  sentTxHashes?: Set<string>,
  /**
   * Tx hashes of claims this device made of received payments (the anchor
   * stamps). A claim is submitted from the recipient's own device, so a local
   * "I sent this" record can name it too, but the balance only went up.
   */
  claimTxHashes?: ReadonlySet<string>,
): 'in' | 'out' | null {
  if (tx.type !== 'Transfer') return null;
  const txHash = (tx.txHash || '').toLowerCase();
  const txLabel = (tx.label || '').toLowerCase();
  if (!txHash && !txLabel) return null;

  // Net incoming wins (DEV-574): a claimed payment is a Transfer In, checked
  // before the sent stamp, which only says this device submitted the tx.
  if (tx.claimTxHash) return 'in';
  if (txHash && claimTxHashes?.has(txHash)) return 'in';
  if (txHash && sentTxHashes?.has(txHash)) return 'out';
  // My own swap's change, not a receipt (DEV-455).
  if (isOwnSwapChangeRow(tx, notes)) return null;

  for (const n of notes) {
    if (!sameToken(tx, n)) continue;
    const noteHash = String(n.txHash || '').toLowerCase();
    const noteLabel = String(n.label || '').toLowerCase();
    if (txHash.length > 0 && noteHash === txHash) return 'in';
    if (txLabel.length > 0 && noteLabel === txLabel) return 'in';
  }
  return null;
}

/**
 * Best-effort raw amount (in token-smallest-units) for a Transfer
 * the user is involved in.
 *
 *   • 'in'  → the SUM of the recipient's note values in this tx
 *             (txHash-matched, deduped by commitment). Exact. A
 *             multi-lineage transfer delivers one note per contributing
 *             lineage (e.g. 14+14 for a 28 send), so summing is required
 *             — the first note alone under-reports. Includes since-SPENT
 *             notes so a received-then-spent transfer still shows its
 *             received amount, not "?".
 *   • 'out' → `sentRawAmount` from the local sender stamp. The
 *             on-chain `tokenAmount` on the ASP event is just the
 *             public relayer fee, not what the user actually sent,
 *             so we don't fall back to it.
 *
 * Returns null when the necessary data isn't available.
 */
export function computeUserTransferAmount(
  tx: Transaction,
  notes: Note[],
  direction: 'in' | 'out' | null,
  sentRawAmount?: string | null,
): bigint | null {
  if (!direction) return null;
  if (tx.type !== 'Transfer') return null;
  const txHash = (tx.txHash || '').toLowerCase();
  if (!txHash) return null;

  if (direction === 'in') {
    // A claim's receipt row (DEV-450) already carries the claimed value. When
    // it falls back to the claim tx's hash, the notes under that hash are the
    // claim's change, which is the value minus what the claim cost.
    if (tx.claimTxHash) {
      try {
        return BigInt(tx.rawAmount);
      } catch {
        return null;
      }
    }
    // Sum EVERY owned note this tx delivered (deduped by commitment): a
    // multi-lineage transfer emits one recipient note per contributing
    // lineage. Include since-SPENT notes — the received amount is the notes'
    // value whether or not they've since been spent (mirrors classifyTransfer).
    const seen = new Set<string>();
    let matched = 0;
    let total = 0n;
    for (const n of notes) {
      if (String(n.txHash || '').toLowerCase() !== txHash) continue;
      if (!sameToken(tx, n)) continue;
      const commitment = String(n.commitment || '').toLowerCase();
      if (commitment && seen.has(commitment)) continue;
      if (commitment) seen.add(commitment);
      matched += 1;
      try {
        total += BigInt(n.value || '0x0');
      } catch {
        return null;
      }
    }
    return matched > 0 ? total : null;
  }

  // direction === 'out' — rely on the locally-stamped raw amount.
  if (!sentRawAmount) return null;
  try {
    const parsed = BigInt(sentRawAmount);
    return parsed > 0n ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Should this ASP feed row be dropped as an internal self-spend?
 *
 * The prefilter counterpart of mergeMyTransactions' Deposit exemption above,
 * and it exists because the two disagreed. The merge learned on 2026-08-30
 * that a lineage row never stands for a Deposit — a reshield spends notes and
 * re-deposits the swapped value in the SAME tx, so that tx hash carries a real
 * Deposit row of its own. The callers' PREFILTER kept dropping by bare tx hash,
 * so the reshield's deposit was swallowed one line before the merge could
 * protect it: Pat, 2026-09-01, saw a signed wallet session show 22 rows against
 * an account-key session's 23, missing exactly that Optimism deposit. The key
 * session kept the row only because, having reconstructed no spends, its
 * internal-hash set was empty.
 *
 * A same-tx reshield legitimately renders two economic legs (the spend and the
 * new deposit). It never renders two spends.
 */
export function isInternalSpendRow(
  tx: { type: string; txHash?: string | null },
  internalTxHashes: ReadonlySet<string>,
): boolean {
  if (tx.type === 'Deposit') return false;
  return !!tx.txHash && internalTxHashes.has(tx.txHash.toLowerCase());
}

/**
 * Should a mine-scoped surface hold this feed row back for now (DEV-394)?
 *
 * While my spends are being classified, a Transfer row I own only through a
 * note has no trustworthy direction: my own change note reads as Transfer In
 * until the lineage row replaces it. Hold exactly those rows. A row this
 * device stamped itself (a send, a paid request) keeps its known direction.
 *
 * `pending` must be false whenever no classification is coming (locked
 * session, failed run), or these rows would stay hidden for good.
 */
export function isHeldForSpendClassification(
  tx: { type: string; txHash?: string | null },
  input: { pending: boolean; sentTxHashes: ReadonlySet<string>; isPaidRequest: (txHash: string) => boolean },
): boolean {
  if (!input.pending || tx.type !== 'Transfer') return false;
  const hash = String(tx.txHash || '').toLowerCase();
  if (hash && input.sentTxHashes.has(hash)) return false;
  return !(hash && input.isPaidRequest(hash));
}

/**
 * Is this feed Transfer row the source-pool leg of a swap in which I hold a
 * note of ANOTHER token (DEV-455)?
 *
 * A transact moves one asset, so a received transfer never leaves me a note of
 * a different token under its hash. A swap does: my own reshield leaves my
 * change note (row token) and my output note (output token) under one hash,
 * and a swap-send paid to me leaves only the output note. Read on its own, the
 * change note made the row "Transfer In" until the Swap row replaced it, which
 * never happens while the snapshot lags the feed. The swap's Deposit row (the
 * Reshield row) already shows the swap, so this row is hidden from my scope.
 *
 * EVM asset addresses only, as sameToken. Reads my notes, nothing else.
 */
export function isOwnSwapChangeRow(
  tx: Pick<Transaction, 'type' | 'txHash' | 'tokenAddress'>,
  notes: readonly Pick<Note, 'txHash' | 'tokenId'>[],
): boolean {
  if (tx.type !== 'Transfer') return false;
  const hash = String(tx.txHash || '').toLowerCase();
  const rowToken = String(tx.tokenAddress || '').toLowerCase();
  const evm = /^0x[0-9a-f]{40}$/;
  if (!hash || !evm.test(rowToken)) return false;
  return notes.some((n) => {
    if (String(n.txHash || '').toLowerCase() !== hash) return false;
    const token = String(n.tokenId || '').toLowerCase();
    return evm.test(token) && token !== rowToken;
  });
}
