import { normalizeCommitment } from '@/services/deposit-ownership';
import { mergeNotesByCommitment } from '@/services/note-sets';

/**
 * Received transfers, from every chain's notes.
 *
 * "Is this row mine" and the own-spend reconstruction both read every chain's
 * notes, so receipts have to as well: decided from the session chain alone, a
 * transfer received on another chain was a row the table knew was mine and
 * could not decode, "Transfer · Private" (Mike, 2026-10-07).
 *
 * A receipt is a note of mine created by a tx that is not my own spend, claim,
 * anchor or recorded action, and that is not a deposit output. Its row replaces
 * the feed's Transfer row for the same tx (mergeMyTransactions).
 *
 * PURE module (no react-native imports) so it is bun-testable.
 */

export type ReceivedNoteLike = {
  commitment: string;
  txHash?: string | null;
  value: string;
  tokenId: string;
  label?: string | null;
  status?: unknown;
  createdAtBlock?: string;
  ownerAddress?: string;
};

export type ReceivedCandidate<N extends ReceivedNoteLike = ReceivedNoteLike> = {
  note: N;
  /** The chain whose note set the note came from. */
  chainId: number;
};

export type ReceivedTransfer<N extends ReceivedNoteLike = ReceivedNoteLike> = {
  txHash: string;
  chainId: number;
  /** The first note of the tx, for the row's token, label and status. */
  first: N;
  /** Every owned note the tx delivered, summed (one per contributing lineage). */
  sum: bigint;
};

export type CollectReceivedOptions = {
  /** Txs whose owned outputs are not a receipt, or that another row explains. Lowercase. */
  skipTxHashes: ReadonlySet<string>;
  /** Deposit output commitments on any chain, canonical (normalizeCommitment). */
  depositCommitments: ReadonlySet<string>;
  /** The chain the snapshot names for a tx. Wins over the note set's chain. */
  txChainIds?: ReadonlyMap<string, number>;
  /** The live session's chain. Its own spends are always matched. */
  sessionChainId: number;
  /** Chains the event snapshot has loaded. */
  loadedChainIds: readonly number[];
  /** Chains whose feeds or snapshot are still pending (per-chain-history.ts). */
  pendingChainIds: readonly number[];
  /** Chains the spend reconstruction found at least one spend of mine on. */
  spendChainIds: ReadonlySet<number>;
};

/**
 * Can a note set's change notes be told apart from receipts?
 *
 * Not until the chain's history has loaded: a chain missing from the snapshot
 * or its feeds hides its deposits and spends, and every note on it would read
 * as received.
 *
 * Own spends are matched with the session's nullifying key. A chain on another
 * key scheme (a staging Sepolia keccak keystore) matches none of them, and
 * there every change note of an own send would read as a receipt. So another
 * chain's notes count only when one of its spends matched, or when it has no
 * SPENT note and so no own spend to match.
 */
function eligibleChains<N extends ReceivedNoteLike>(
  candidates: readonly ReceivedCandidate<N>[],
  options: Pick<CollectReceivedOptions, 'sessionChainId' | 'spendChainIds' | 'loadedChainIds' | 'pendingChainIds'>,
): (chainId: number) => boolean {
  const withSpentNotes = new Set<number>();
  for (const { note, chainId } of candidates) {
    if (String(note.status ?? '').toUpperCase() === 'SPENT') withSpentNotes.add(chainId);
  }
  return (chainId) => options.loadedChainIds.includes(chainId)
    && !options.pendingChainIds.includes(chainId)
    && (chainId === options.sessionChainId
      || options.spendChainIds.has(chainId)
      || !withSpentNotes.has(chainId));
}

/**
 * Every tx whose owned outputs are not a receipt, or that another row explains:
 * - my own spends (the spend row covers their change);
 * - payments a claim row stands for: the claimed note stays in the notes
 *   (SPENT) under the sender's tx (DEV-450 review);
 * - my confirmed anchors, known locally before the snapshot has them;
 * - anything THIS device did or sent, on any chain: own actions, sent
 *   transfers and paid requests. A paid request leaves no own action, and in
 *   the minutes before the snapshot has the tx it is not a reconstructed spend
 *   either, so only its stamp keeps the payer's change from reading as a
 *   receipt;
 * - a row of another kind for the tx (a feed Deposit, Withdrawal or Exit, or
 *   an own Deposit row synthesised from local notes).
 * Lowercase.
 */
export function receiptSkipTxHashes(input: {
  spends: readonly { txHash: string; kind: string; receivedTxHash?: string }[];
  anchorTxHashes: Iterable<string>;
  localTxHashes: Iterable<string>;
  rows: readonly { type: string; txHash?: string | null }[];
}): Set<string> {
  const out = new Set<string>();
  const add = (hash: string | null | undefined) => { if (hash) out.add(hash.toLowerCase()); };
  for (const s of input.spends) {
    add(s.txHash);
    if (s.kind === 'claim') add(s.receivedTxHash);
  }
  for (const hash of input.anchorTxHashes) add(hash);
  for (const hash of input.localTxHashes) add(hash);
  for (const row of input.rows) if (row.type !== 'Transfer') add(row.txHash);
  return out;
}

/** One account's notes tagged with their chain, deduped the way note-sets does it. */
export function tagNotesByChain<N extends ReceivedNoteLike>(
  live: { chainId: number; notes: readonly N[] } | null,
  stored: readonly { chainId: number; notes: readonly N[] }[],
): ReceivedCandidate<N>[] {
  const tag = (set: { chainId: number; notes: readonly N[] }) =>
    set.notes.map((note) => ({ commitment: note.commitment, note, chainId: set.chainId }));
  return mergeNotesByCommitment(live ? tag(live) : [], stored.map(tag))
    .map(({ note, chainId }) => ({ note, chainId }));
}

export function collectReceivedTransfers<N extends ReceivedNoteLike>(
  candidates: readonly ReceivedCandidate<N>[],
  options: CollectReceivedOptions,
): ReceivedTransfer<N>[] {
  const eligible = eligibleChains(candidates, options);
  const byTx = new Map<string, ReceivedTransfer<N>>();
  for (const { note, chainId } of candidates) {
    if (!eligible(chainId)) continue;
    const txHash = String(note.txHash || '').toLowerCase();
    if (!txHash || /^0x0*$/.test(txHash) || options.skipTxHashes.has(txHash)) continue;
    const canonical = normalizeCommitment(String(note.commitment));
    if (canonical && options.depositCommitments.has(canonical)) continue;
    let value: bigint;
    try {
      value = BigInt(note.value);
    } catch {
      continue;
    }
    const entry = byTx.get(txHash);
    if (entry) entry.sum += value;
    else byTx.set(txHash, { txHash, chainId: options.txChainIds?.get(txHash) ?? chainId, first: note, sum: value });
  }
  return [...byTx.values()];
}

/**
 * While a new spend classification is pending, the last run's result still
 * stands for the notes it saw, as that run saw them: a note that arrived since
 * may be the change of a send that run never saw, which would read as a
 * receipt, and a note that turned SPENT since would make its chain look
 * unmatched against that run's spends. Commitments compared lowercase, as
 * note-sets dedupes them.
 */
export function onlyClassifiedNotes<N extends ReceivedNoteLike>(
  candidates: readonly ReceivedCandidate<N>[],
  classifiedNotes: readonly N[],
): ReceivedCandidate<N>[] {
  const byCommitment = new Map(classifiedNotes.map((n) => [String(n.commitment).toLowerCase(), n]));
  return candidates.flatMap((c) => {
    const classified = byCommitment.get(String(c.note.commitment).toLowerCase());
    return classified ? [{ note: classified, chainId: c.chainId }] : [];
  });
}
