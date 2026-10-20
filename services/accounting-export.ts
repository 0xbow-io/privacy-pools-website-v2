// The accounting CSV builder — extracted from the accounting modal so the row
// mapping (Koinly template, date/cell helpers, withdrawal fee split, and the
// self-audit verify / proof-of-origin links folded into each Description) is
// pure and unit-testable. The modal keeps the UI (selection chips, filters, the
// browser download) and hands its filtered items here.
//
// The fee lookup and origin-proof builder are injectable so a fixture test can
// drive the fee split and the exit's proof-of-origin link without seeding a
// device store or standing up the prover; production wires the real ones.

import { formatUnits } from 'viem';
import { getTokenMetadata } from '@/config/tokens';
import {
  buildOwnedNoteKey,
  buildSentPaymentKey,
  encodePartialViewingKey,
  encodePartialViewingKeyBatch,
  buildVerifyUrl,
  buildOriginProofForTarget,
  encodeOriginProof,
  type PartialViewingKeyV1,
  type SentNoteDisclosure,
} from '@/services/audit-receipt';
import { classifyTransfer, sameToken } from '@/services/transfer-direction';
import { rowTypeLabel } from '@/services/row-type-label';
import { snapshotTimestampToMs } from '@/services/outgoing-transfers';
import { normalizeCommitment } from '@/services/deposit-ownership';
import type { Note } from '@/services/sdk-types';
import type { SnapshotDeposit, SnapshotRagequit } from '@/services/api-types';
import type { Transaction } from '@/components/pools-provider';
import { convertShares, type ShareConversion } from '@/services/share-rate-history';
import { hexKey, isSwapOutputRow, isSwapRow } from '@/services/swap-rows';

// Withdrawals, Exits and standalone Fees are public on-chain (amount +
// recipient/processor visible in the tx) and have no private viewing key —
// they're CSV-only, with amount/recipient sourced from the activity feed rather
// than a note bundle.
// A 'trade' is a private swap: one line with both legs, each in its own chain
// and token, keyed by the output note (the source leg never left the account).
export type AcctType = 'deposit' | 'transfer-in' | 'transfer-out' | 'withdraw' | 'fee' | 'exit' | 'trade';

export type AcctItem = {
  txHash: string;
  type: AcctType;
  // null for withdraw/exit (public, no private viewing key). A transfer can
  // carry SEVERAL bundles: a multi-lineage transfer emits one recipient note
  // per contributing lineage, and each note needs its own partial viewing key
  // (one key attached to an aggregate amount would not verify).
  bundles: PartialViewingKeyV1[] | null;
  // Amount data usable for the CSV whether or not there's a bundle. value is
  // smallest-units as hex (bundle) or decimal (feed) — BigInt parses both.
  value: string;
  tokenId: string;
  chainId: number;
  timestamp: number;
  // recipient (transfer-out / withdraw / exit) or depositor (deposit).
  counterparty: string | null;
  // Activity-feed label (present for exits; used to build proof-of-origin).
  label: string | null;
  // transfer-out only: the relayer fee read from chain (the tx's
  // withdrawnValue on the relayer's transfer route), smallest units. The
  // Koinly Fee column falls back to it when this device has no fee record.
  relayFee?: string;
  /** The activity list's label when it says more than the type (DEV-575),
   *  e.g. "Transfer In & registration" or "Gas for viewing key". The CSV
   *  description uses it, so an export reads like the list. */
  activity?: string;
  /** trade only: the received leg. `value`/`tokenId`/`chainId` are the sent leg. */
  received?: { value: string; tokenId: string; chainId: number };
};

/** Every exportable type, in the modal's order; all are selected by default. */
export const EXPORT_TYPES: readonly AcctType[] = ['deposit', 'transfer-out', 'transfer-in', 'trade', 'withdraw', 'fee', 'exit'];

export const TYPE_LABEL: Record<AcctType, string> = {
  deposit: 'Deposit', 'transfer-in': 'Transfer in', 'transfer-out': 'Transfer out', withdraw: 'Withdrawal', fee: 'Fee', exit: 'Exit', trade: 'Swap',
};

// Lowercased type labels used for the Koinly Description prose.
const DESC_LABEL: Record<AcctType, string> = {
  deposit: 'deposit', 'transfer-in': 'transfer in', 'transfer-out': 'transfer out', withdraw: 'withdrawal', fee: 'fee', exit: 'exit', trade: 'swap',
};

/**
 * Exact ownership evidence for the accounting scope. Every set is built from
 * evidence that identifies THIS account precisely:
 *  - noteTxHashes — txs that created a note the account owns (receives/change);
 *  - sentTxHashes — locally-stamped outgoing transfers;
 *  - withdrawTxHashes — locally-recorded withdrawal fees (written only when
 *    this account submitted the withdrawal);
 *  - exitTxHashes — exits proven by the exact exited commitment (or, in
 *    wallet identity mode, the ragequitter address);
 *  - walletAddressLc — the depositing wallet, ownership evidence ONLY in
 *    wallet identity mode (with an imported account key the wallet is just
 *    the payer).
 * A shared LABEL is deliberately NOT evidence: labels survive transfers
 * across parties, so Alice's spent label-L notes must not claim Bob's later
 * label-L exit for her ledger.
 */
export type OwnershipEvidence = {
  noteTxHashes: Set<string>;
  sentTxHashes: Set<string>;
  withdrawTxHashes: Set<string>;
  exitTxHashes: Set<string>;
  walletAddressLc: string | null;
};

/** Pure per-row ownership predicate for the accounting scope (see
 *  {@link OwnershipEvidence}); reconstructed lineage rows carry their own
 *  nullifier-exact evidence and are merged by the caller separately. */
export function isAccountingTxMine(
  tx: Pick<Transaction, 'type' | 'txHash' | 'fullAddress'>,
  ev: OwnershipEvidence,
): boolean {
  const txHash = (tx.txHash || '').toLowerCase();
  if (!txHash) return false;
  const noteMatch = ev.noteTxHashes.has(txHash);
  if (tx.type === 'Deposit') {
    const addrMatch = !!ev.walletAddressLc
      && !!tx.fullAddress
      && tx.fullAddress.toLowerCase() === ev.walletAddressLc;
    return addrMatch || noteMatch;
  }
  if (tx.type === 'Transfer') {
    // Include stamped sends even when local note state is unavailable — the
    // builder recovers the amount from the stamp (CSV-only when unkeyed).
    return noteMatch || ev.sentTxHashes.has(txHash);
  }
  if (tx.type === 'Withdrawal') return noteMatch || ev.withdrawTxHashes.has(txHash);
  if (tx.type === 'Exit') return ev.exitTxHashes.has(txHash);
  return false;
}

/** Injected, device-backed lookups the item builder needs but this pure module
 *  must not read directly (they hit expo/localStorage stores). */
export type AccountingLookups = {
  /** Recipient-note disclosures captured when this wallet sent a transfer —
   *  one per recipient note (a multi-lineage transfer discloses several). */
  findSentAudits: (txHash: string) => SentNoteDisclosure[];
  /** Local send stamp for a transfer with no disclosure: the recipient-facing
   *  amount (hex) and address. The on-chain event carries only the relayer fee,
   *  so a stamped-but-undisclosed send has no other source for its true value. */
  findSentTransfer: (txHash: string) => { rawAmount: string; recipient: string } | null;
};

export type AccountingSources = AccountingLookups & {
  /** The connected wallet's own transactions — the mine-scoped activity feed
   *  (note/label ownership + reconstructed lineage rows), NOT the global feed.
   *  This is the ownership gate: a withdrawal/exit not in this set isn't ours. */
  mineRows: Transaction[];
  /** Owned notes, for deposit/received-transfer viewing keys. */
  notes: Note[];
  /** Owned notes on EVERY chain, by chain: a swap's output note lives on its
   *  own chain, which need not be the session's. Defaults to `notes` alone. */
  notesByChain?: ReadonlyMap<number, readonly Note[]>;
  /** Locally-stamped outgoing transfer txHashes (sender signal). */
  sentTxHashes: Set<string>;
  /** ASP-classified transfer txHashes — an event 'Withdrawal' whose hash is in
   *  here is really a mislabeled transfer (amount = fee) and must be skipped. */
  transferTxHashes: Set<string>;
  transferClassificationReady: boolean;
  /** Full-history deposits by this wallet, from the event snapshot (EVM). Adds
   *  the deposits older than the windowed feed. */
  myDeposits: SnapshotDeposit[];
  /** Full-history ragequit exits by this wallet, from the event snapshot. */
  myExits: SnapshotRagequit[];
  /** Chain id to tag snapshot-sourced (EVM) deposit/exit rows with. */
  evmChainId: number;
  /** Optional clock for the bundles' informational createdAt stamp — lets the
   *  golden pipeline test pin byte-exact output. Defaults to the key
   *  builders' own Date.now(). */
  nowMs?: number;
};

/**
 * The accounting item set: the connected wallet's own transactions, over full
 * history, keyed for proof where a viewing key exists.
 *
 * Derived from the SAME mine-scoped feed the activity list uses — not the raw
 * global/windowed event feed — so it inherits that feed's ownership gate and
 * its reconstructed lineage rows. That fixes three defects the old per-type
 * derivation had:
 *   1. foreign withdrawals/exits (present in the global feed but not ours) no
 *      longer leak in — they're absent from the mine feed;
 *   2. sends that exist only as a reconstructed lineage row, or as a stamped
 *      event row with no disclosure, are recorded (CSV-only when unkeyed)
 *      instead of dropped;
 *   3. deposits and exits older than the event window are recovered from the
 *      full event snapshot (myDeposits / myExits) and merged in, deduped by
 *      txHash against what the feed already produced.
 *
 * Batch-withdrawal collapse: PrivacyPoolRelay.relayBatch emits one Transacted
 * log per item, so a single on-chain batch tx surfaces as N same-hash rows —
 * each carrying one item's value. Left as-is they would inflate the withdrawal
 * count and (via the aggregate fee stored once under that hash) subtract that
 * fee from every item. Rows sharing (chainId, txHash, type, tokenId) fold into
 * one with the summed value, so a batch is a single row and the aggregate fee
 * applies once. Non-batched txs have unique hashes, so this is a no-op for
 * them. Public rows (withdraw/exit) carry no viewing-key bundle, so collapsing
 * can't lose per-note key material; a defensive guard keeps the first bundle
 * if two private rows ever collide.
 */
export function buildAccountingItems(src: AccountingSources): AcctItem[] {
  const {
    mineRows, notes, sentTxHashes, transferTxHashes, transferClassificationReady,
    myDeposits, myExits, evmChainId, findSentAudits, findSentTransfer, nowMs, notesByChain,
  } = src;
  // createdAt is informational-only on a partial viewing key; pin it when the
  // caller supplies a clock so golden tests stay deterministic.
  const stamp = (b: PartialViewingKeyV1): PartialViewingKeyV1 =>
    (nowMs != null ? { ...b, createdAt: nowMs } : b);

  const items: AcctItem[] = [];
  const seenDepositTx = new Set<string>();
  const seenExitTx = new Set<string>();
  const noteByCommitment = (commitment: string | null): Note | undefined =>
    (commitment
      ? notes.find((n) => normalizeCommitment(String(n.commitment ?? '')) === commitment)
      : undefined);
  // A swap leaves several owned notes under one hash (source-token change plus
  // the output deposit), so a deposit's note must also match its token.
  const depositNote = (tx: Transaction, h: string): Note | undefined => {
    for (const dep of myDeposits) {
      if ((dep.txHash || '').toLowerCase() !== h) continue;
      const n = noteByCommitment(normalizeCommitment(dep.outputCommitment));
      if (n && sameToken(tx, n)) return n;
    }
    return notes.find((n) => String(n.txHash || '').toLowerCase() === h && sameToken(tx, n));
  };
  const notesByTxHash = (h: string): Note[] => {
    const seen = new Set<string>();
    const matched: Note[] = [];
    for (const n of notes) {
      if (String(n.txHash || '').toLowerCase() !== h) continue;
      const c = String(n.commitment || '').toLowerCase();
      if (c && seen.has(c)) continue;
      if (c) seen.add(c);
      matched.push(n);
    }
    return matched;
  };

  // Every pass skips exactly the deposits a trade credits: the swap's output is
  // booked once, as the trade's received leg.
  // A trade credits an output this account holds: a delivered swap whose
  // output note is here. Anything else exports as its source withdrawal.
  const ownedOutputNotes = (swap: Transaction & { swapOut: { chainId: number; commitments: string[] } }) =>
    (notesByChain?.get(swap.swapOut.chainId) ?? (swap.swapOut.chainId === evmChainId ? notes : []))
      .filter((n) => swap.swapOut.commitments.includes(hexKey(String(n.commitment ?? ''))));
  const tradeRows = mineRows.filter(isSwapRow).filter((swap) => !swap.swapOut.delivering && ownedOutputNotes(swap).length > 0);
  const tradeCredited = new Set<string>();
  for (const swap of tradeRows) for (const c of swap.swapOut.commitments) tradeCredited.add(c);
  const creditedByTrade = (tx: Transaction) => tradeRows.some((swap) => isSwapOutputRow(tx, swap.swapOut));

  for (const tx of mineRows) {
    const txHash = (tx.txHash || '').toLowerCase();
    if (!txHash) continue;

    if (isSwapRow(tx)) {
      const out = tx.swapOut;
      // Not delivered yet, or the output note is not held here: what can be
      // shown so far is the source withdrawal. Nothing is credited.
      if (!tradeRows.includes(tx)) {
        items.push({ txHash: tx.txHash, type: 'withdraw', bundles: null, value: tx.rawAmount, tokenId: tx.tokenAddress, chainId: tx.chainId, timestamp: tx.timestamp, counterparty: null, label: null });
        continue;
      }
      const outputNotes = ownedOutputNotes(tx);
      const bundles = outputNotes.map((n) => stamp(buildOwnedNoteKey(n as never, out.chainId)));
      items.push({
        txHash: tx.txHash,
        type: 'trade',
        bundles,
        value: tx.rawAmount,
        tokenId: tx.tokenAddress,
        chainId: tx.chainId,
        timestamp: tx.timestamp,
        counterparty: null,
        label: null,
        received: { value: out.rawAmount, tokenId: out.tokenAddress, chainId: out.chainId },
      });
      continue;
    }

    if (tx.type === 'Deposit') {
      if (creditedByTrade(tx)) continue;
      const owned = depositNote(tx, txHash);
      if (!owned) continue; // no note → no viewing key; the snapshot pass may recover it
      const bundle = stamp(buildOwnedNoteKey(owned as never, tx.chainId));
      items.push({ txHash: tx.txHash, type: 'deposit', bundles: [bundle], value: bundle.value, tokenId: bundle.tokenId, chainId: tx.chainId, timestamp: tx.timestamp, counterparty: tx.fullAddress || null, label: tx.label ?? null, ...activityOf(tx, null) });
      seenDepositTx.add(txHash);
      continue;
    }

    // A transfer to myself: only the relayer fee left the balance, so that is
    // the whole entry. Never a disposal of the value moved, which stayed mine.
    if (tx.direction === 'self') {
      items.push({ txHash: tx.txHash, type: 'fee', bundles: null, value: tx.rawAmount, tokenId: tx.tokenAddress, chainId: tx.chainId, timestamp: tx.timestamp, counterparty: null, label: tx.label ?? null, ...activityOf(tx, 'self') });
      continue;
    }

    if (tx.type === 'Transfer') {
      const direction = tx.direction ?? classifyTransfer(tx, notes, sentTxHashes);
      if (direction === 'out') {
        const sent = findSentAudits(tx.txHash);
        if (sent.length > 0) {
          // Keyed: one bundle per recipient-note disclosure captured at send
          // time (a multi-lineage send discloses several); the ledger value is
          // their sum.
          const bundles = sent.map((d) => stamp(buildSentPaymentKey(d)));
          const total = sent.reduce((s, d) => s + BigInt(d.value), 0n);
          items.push({ txHash: tx.txHash, type: 'transfer-out', bundles, value: `0x${total.toString(16)}`, tokenId: bundles[0].tokenId, chainId: tx.chainId, timestamp: tx.timestamp, counterparty: sent[0].ownerAddress, label: tx.label ?? null, ...relayFeeOf(tx) });
        } else {
          // No disclosure key, but still record the send (CSV-only). A lineage
          // row carries the true outflow; a stamped event row carries only the
          // fee on-chain, so read the local stamp for its real amount.
          let value: string | null = null;
          let counterparty: string | null = null;
          if (tx.isLineageSynthetic) {
            value = tx.rawAmount;
            counterparty = tx.fullAddress || null;
          } else {
            const stamp = findSentTransfer(tx.txHash);
            if (stamp) { value = stamp.rawAmount; counterparty = stamp.recipient || null; }
          }
          if (value != null) {
            items.push({ txHash: tx.txHash, type: 'transfer-out', bundles: null, value, tokenId: tx.tokenAddress, chainId: tx.chainId, timestamp: tx.timestamp, counterparty, label: tx.label ?? null, ...relayFeeOf(tx) });
          }
        }
      } else if (direction === 'in') {
        // Incoming: the owned notes ARE the received notes → correct proof.
        // A multi-lineage transfer delivers one note per contributing lineage,
        // so gather EVERY owned note this tx created (deduped by commitment)
        // and sum them — the first note alone under-reports a 14+14 receive
        // as 14. SPENT notes are deliberately kept — a tax ledger must keep a
        // historical receive even after the user later spends it. The protocol
        // doesn't record the SENDER, so transfer-in has no counterparty.
        // A claim row that fell back to the claim tx's own hash: the notes under
        // it are the claim's CHANGE (value minus the cost booked below), so the
        // receipt comes from the row's amount instead (DEV-450 review).
        const claimFallback = !!tx.claimTxHash && tx.claimTxHash.toLowerCase() === txHash;
        const ownedNotes = claimFallback ? [] : notesByTxHash(txHash).filter((n) => sameToken(tx, n));
        if (ownedNotes.length > 0) {
          const bundles = ownedNotes.map((n) => stamp(buildOwnedNoteKey(n as never, tx.chainId)));
          const total = bundles.reduce((s, b) => s + BigInt(b.value), 0n);
          items.push({ txHash: tx.txHash, type: 'transfer-in', bundles, value: `0x${total.toString(16)}`, tokenId: bundles[0].tokenId, chainId: tx.chainId, timestamp: tx.timestamp, counterparty: null, label: tx.label ?? null, ...activityOf(tx, 'in') });
        } else if (tx.isLineageSynthetic) {
          // Received transfer whose note we no longer hold: record it CSV-only
          // from the reconstructed amount so income isn't dropped.
          items.push({ txHash: tx.txHash, type: 'transfer-in', bundles: null, value: tx.rawAmount, tokenId: tx.tokenAddress, chainId: tx.chainId, timestamp: tx.timestamp, counterparty: null, label: tx.label ?? null, ...activityOf(tx, 'in') });
        }
        // A claim's receipt row carries what claiming it cost; that used to be
        // its own Fee row, and the ledger must still reach the balance (DEV-450).
        if (tx.claimTxHash && tx.claimCostRaw && BigInt(tx.claimCostRaw) > 0n) {
          items.push({ txHash: tx.claimTxHash, type: 'fee', bundles: null, value: tx.claimCostRaw, tokenId: tx.tokenAddress, chainId: tx.chainId, timestamp: tx.timestamp, counterparty: null, label: null });
        }
      }
      continue;
    }

    if (tx.type === 'Withdrawal' || tx.type === 'Exit') {
      // An event row can be an ASP-mislabeled transfer (amount = relayer fee);
      // trust it only once classification is ready and its hash isn't a known
      // transfer. A reconstructed lineage row is already the true withdrawal.
      const trusted = tx.isLineageSynthetic || (transferClassificationReady && !transferTxHashes.has(txHash));
      if (!trusted) continue;
      const type: AcctType = tx.type === 'Exit' ? 'exit' : 'withdraw';
      items.push({ txHash: tx.txHash, type, bundles: null, value: tx.rawAmount, tokenId: tx.tokenAddress, chainId: tx.chainId, timestamp: tx.timestamp, counterparty: tx.fullAddress || null, label: tx.label ?? null, ...activityOf(tx, null) });
      if (type === 'exit') seenExitTx.add(txHash);
      continue;
    }
  }

  // Full-history augmentation from the event snapshot (EVM): the deposits and
  // exits older than the windowed feed. Deduped by txHash against the feed rows
  // above so an in-window one isn't counted twice.
  for (const dep of myDeposits) {
    const h = (dep.txHash || '').toLowerCase();
    if (!h || seenDepositTx.has(h)) continue;
    if (tradeCredited.has(hexKey(dep.outputCommitment))) continue;
    const owned = noteByCommitment(normalizeCommitment(dep.outputCommitment));
    if (owned) {
      // We still hold the note → keyed deposit (provable viewing key).
      const bundle = stamp(buildOwnedNoteKey(owned as never, evmChainId));
      items.push({ txHash: dep.txHash, type: 'deposit', bundles: [bundle], value: bundle.value, tokenId: bundle.tokenId, chainId: evmChainId, timestamp: snapshotTimestampToMs(dep.blockTimestamp), counterparty: dep.depositAddress || null, label: null });
    } else {
      // The note was spent/consolidated away, but a deposit is a public
      // on-chain event (from + amount are in the clear), so it still belongs in
      // the ledger — recorded CSV-only from the snapshot, with no viewing key.
      items.push({ txHash: dep.txHash, type: 'deposit', bundles: null, value: dep.depositedValue, tokenId: dep.asset, chainId: evmChainId, timestamp: snapshotTimestampToMs(dep.blockTimestamp), counterparty: dep.depositAddress || null, label: null });
    }
    seenDepositTx.add(h);
  }
  for (const rq of myExits) {
    const h = (rq.txHash || '').toLowerCase();
    if (!h || seenExitTx.has(h)) continue;
    items.push({ txHash: rq.txHash, type: 'exit', bundles: null, value: rq.withdrawnValue, tokenId: rq.asset, chainId: evmChainId, timestamp: snapshotTimestampToMs(rq.blockTimestamp), counterparty: rq.ragequitter || null, label: rq.label ?? null });
    seenExitTx.add(h);
  }

  // Batch collapse (see the doc comment above).
  const collapsed = new Map<string, AcctItem>();
  for (const item of items) {
    const key = `${item.chainId}|${item.txHash.toLowerCase()}|${item.type}|${item.tokenId.toLowerCase()}`;
    const existing = collapsed.get(key);
    if (!existing) {
      collapsed.set(key, item);
      continue;
    }
    let summed = existing.value;
    try {
      summed = (BigInt(existing.value) + BigInt(item.value)).toString();
    } catch {
      /* keep the existing value if either is unparseable */
    }
    collapsed.set(key, {
      ...existing,
      value: summed,
      bundles: existing.bundles ?? item.bundles,
      counterparty: existing.counterparty ?? item.counterparty,
      // One fee per tx, never summed.
      relayFee: existing.relayFee ?? item.relayFee,
      timestamp: Math.min(existing.timestamp, item.timestamp),
    });
  }
  return Array.from(collapsed.values());
}

// Koinly universal/advanced import template — handles deposits, withdrawals,
// transfers and standalone pool fees via separate Sent/Received/Fee columns:
//   Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Label,Description,TxHash
//   2018-01-03 14:25 UTC,,,1,BTC,,,,,mining,,0x12345   (a receive: Received only)
//   2018-01-02 14:25 UTC,0.5,BTC,,,,,,,,,              (a send: Sent only)
// The Fee column carries the RELAYER fee of a relayed spend, whenever we can
// identify it: a withdrawal's fee (folded out of the gross that left the pool),
// an outgoing transfer's fee (charged on top of what the recipient received),
// or the whole of a transfer to yourself or a claim, each booked as a fee
// alone.
// None has a matching counterpart tx for Koinly to derive it from, and without
// it the export cannot be reconciled against the balance. Chain gas on a
// self-submitted tx is still left to Koinly.
export const KOINLY_HEADER =
  'Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Label,Description,TxHash';

/** Parse a `YYYY-MM-DD` day to a local epoch ms at the day's start or end,
 *  rejecting calendar-invalid dates. Used by the modal's date-range filters. */
export function parseDay(s: string, end: boolean): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]); const mo = Number(m[2]); const day = Number(m[3]);
  const d = new Date(y, mo - 1, day, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0);
  // Reject calendar-invalid dates (e.g. 2026-02-31) that Date silently rolls
  // forward — otherwise the filter range would shift unexpectedly.
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return null;
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export function koinlyDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

export function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The activity list's own label for a row whose label says more than its
 * export type (DEV-575): a claim that also registered the account, the
 * account-setup spends, and withdrawals through a swap route (a swap-send, a
 * receive-as payout). Same rowTypeLabel as the list, so the two never drift.
 */
function activityOf(tx: Transaction, direction: 'in' | 'out' | 'self' | null): Pick<AcctItem, 'activity'> {
  if (!tx.setupKind && !tx.withRegistration && !tx.viaSwap && !tx.sentToOther && !tx.receivedAs && !tx.swappedFrom && direction !== 'self') return {};
  return { activity: rowTypeLabel({ ...tx, direction: direction ?? tx.direction }) };
}

function relayFeeOf(tx: Pick<Transaction, 'relayFeeRaw'>): Pick<AcctItem, 'relayFee'> {
  return tx.relayFeeRaw ? { relayFee: tx.relayFeeRaw } : {};
}

/** Injected dependencies for the row builder. The fee lookup is required and
 *  supplied by the caller (its store is device/expo-backed, kept out of this
 *  pure module so it stays bun-testable); the origin-proof builder defaults to
 *  the real one (audit-receipt has no device deps). */
export type KoinlyExportDeps = {
  /** Owned notes, needed to build a withdrawal/exit proof-of-origin link. */
  notes: readonly unknown[];
  /** Recorded relayer fee for a relayed spend (withdrawal or outgoing
   *  transfer), if captured on this device. */
  findFee: (txHash: string) => { feeAmount: string } | null | undefined;
  /** Proof-of-origin builder for public withdrawals/exits. */
  buildOriginProof?: typeof buildOriginProofForTarget;
  /** Share→underlying rate at the item's time; null for anything that is not a
   *  share. Only historical coverage (atTx: true) is accounting data. Missing
   *  coverage keeps share amounts and symbols; today's display approximation
   *  must not claim a historical underlying amount. */
  shareConversion?: (it: AcctItem) => ShareConversion | null | undefined;
};

/** Build one Koinly CSV line for an accounting item. Pure given its deps: no
 *  store reads or network beyond the injected lookups. */
export async function buildKoinlyRow(it: AcctItem, deps: KoinlyExportDeps): Promise<string> {
  const { findFee } = deps;
  const buildOriginProof = deps.buildOriginProof ?? buildOriginProofForTarget;

  const token = getTokenMetadata(it.tokenId, it.chainId);
  // Missing historical coverage keeps share amounts/symbols: a display
  // approximation is not accounting data.
  const candidate = deps.shareConversion?.(it);
  const conv = candidate?.atTx ? candidate : null;
  const units = (wei: bigint): string => (conv ? formatUnits(convertShares(conv, wei), conv.decimals) : formatUnits(wei, token.decimals));
  const currency = conv ? conv.symbol : token.symbol;
  const amt = units(BigInt(it.value));
  // Into the pool (deposit / received transfer) → Received columns; out of the
  // pool (sent transfer / withdrawal / exit) → Sent columns. Standalone pool
  // fees use ONLY the Fee columns below: putting them in Sent would recreate
  // the phantom-disposal bug under a different name.
  const received = it.type === 'deposit' || it.type === 'transfer-in';
  // Address for the Description: deposit shows the depositing wallet (from);
  // sends/withdrawals/exits show the recipient (to); transfer-in shows the
  // recipient (you) since the sender isn't recorded on-chain.
  const addr = it.type === 'transfer-in' ? (it.bundles?.[0]?.ownerAddress ?? '') : (it.counterparty ?? '');
  const prep = it.type === 'deposit' ? 'from' : 'to';
  // Itemize a withdrawal's relayer fee when we captured it at send time: the
  // feed only has the gross (net + fee), so split into Sent + Fee.
  let sentAmt = amt; // gross by default
  let feeAmt = '';
  let feeCur = '';
  if (it.type === 'fee') {
    sentAmt = '';
    feeAmt = amt;
    feeCur = currency;
  } else if (it.type === 'withdraw') {
    const wf = findFee(it.txHash);
    if (wf) {
      try {
        const gross = BigInt(it.value);
        const fee = BigInt(wf.feeAmount);
        if (fee > 0n && fee <= gross) {
          sentAmt = units(gross - fee);
          feeAmt = units(fee);
          feeCur = currency;
        }
      } catch { /* keep gross, no fee */ }
    }
  } else if (it.type === 'trade') {
    // The relayer fee is inside the gross that went into the swap, as on a
    // withdrawal, and only this device's stamp can split it out.
    const wf = findFee(it.txHash);
    if (wf) {
      try {
        const gross = BigInt(it.value);
        const fee = BigInt(wf.feeAmount);
        if (fee > 0n && fee <= gross) {
          sentAmt = units(gross - fee);
          feeAmt = units(fee);
          feeCur = currency;
        }
      } catch { /* keep gross, no fee */ }
    }
  } else if (it.type === 'transfer-out') {
    // Mirror image of the withdrawal case: a relayed transfer's fee is charged
    // ON TOP of the amount the recipient received, so the row amount is already
    // net and only the Fee column is added. Without this the CSV understates
    // the spend by the fee, exactly like the in-app history did. The fee is
    // on chain too, so a transfer sent from another device still has it.
    const feeRaw = findFee(it.txHash)?.feeAmount ?? it.relayFee;
    if (feeRaw) {
      try {
        const fee = BigInt(feeRaw);
        if (fee > 0n) {
          feeAmt = units(fee);
          feeCur = currency;
        }
      } catch { /* no fee column */ }
    }
  }
  let desc = `Privacy Pools ${it.activity ? it.activity.toLowerCase() : DESC_LABEL[it.type]}${addr ? ` ${prep} ${addr}` : ''}`;
  // Fold a verify link into every row so the CSV is self-auditable: a
  // viewing-key link for deposits/transfers (have a private note), and a
  // proof-of-origin link for public withdrawals/exits.
  if (it.bundles && it.bundles.length > 0) {
    const encoded = it.bundles.length > 1
      ? encodePartialViewingKeyBatch(it.bundles)
      : encodePartialViewingKey(it.bundles[0]);
    desc += ` · verify: ${buildVerifyUrl(encoded)}`;
  } else if (it.type === 'withdraw' || it.type === 'exit') {
    try {
      const proof = await buildOriginProof({
        chainId: it.chainId,
        notes: deps.notes as never,
        target: {
          type: it.type,
          txHash: it.txHash as `0x${string}`,
          label: (it.label ?? null) as `0x${string}` | null,
          recipient: (it.counterparty ?? undefined) as `0x${string}` | undefined,
          value: it.value,
          tokenId: it.tokenId as `0x${string}`,
        },
      });
      if (proof) desc += ` · proof of origin: ${buildVerifyUrl(encodeOriginProof(proof))}`;
    } catch { /* origin proof is best-effort; omit on failure */ }
  }
  // A trade's received leg, in its own chain's token and units.
  let recvAmt = '';
  let recvCur = '';
  if (it.type === 'trade' && it.received) {
    const leg = { ...it, ...it.received };
    const rToken = getTokenMetadata(leg.tokenId, leg.chainId);
    const rCandidate = deps.shareConversion?.(leg);
    const rConv = rCandidate?.atTx ? rCandidate : null;
    const rWei = BigInt(leg.value);
    recvAmt = rConv ? formatUnits(convertShares(rConv, rWei), rConv.decimals) : formatUnits(rWei, rToken.decimals);
    recvCur = rConv ? rConv.symbol : rToken.symbol;
  }
  const cols = it.type === 'fee'
    ? [koinlyDate(it.timestamp), '', '', '', '', feeAmt, feeCur, '', '', '', desc, it.txHash]
    : it.type === 'trade'
    ? [koinlyDate(it.timestamp), sentAmt, currency, recvAmt, recvCur, feeAmt, feeCur, '', '', '', desc, it.txHash]
    : received
    // Date, SentAmt, SentCur, RecvAmt, RecvCur, FeeAmt, FeeCur, NW, NWCur, Label, Desc, TxHash
      ? [koinlyDate(it.timestamp), '', '', amt, currency, '', '', '', '', '', desc, it.txHash]
      : [koinlyDate(it.timestamp), sentAmt, currency, '', '', feeAmt, feeCur, '', '', '', desc, it.txHash];
  return cols.map((c) => csvCell(String(c))).join(',');
}

/** Build the full Koinly CSV (header + one row per item); oldest-first is the
 *  caller's responsibility (the modal sorts before calling). */
export async function buildKoinlyCsv(items: AcctItem[], deps: KoinlyExportDeps): Promise<string> {
  const rows = await Promise.all(items.map((it) => buildKoinlyRow(it, deps)));
  return [KOINLY_HEADER, ...rows].join('\n');
}
