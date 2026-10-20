// One activity row per private swap.
//
// A Swap-tab swap spends my notes and deposits the swapped value as a new note
// in the same transaction, so the feed carries a Withdrawal (or Transfer) row
// for the spend and a Deposit row for the output, and both are mine. The spend
// classifier (services/outgoing-transfers.ts, kind 'swap') proves the pairing
// from my own notes on the spend's chain, so the activity lists show ONE Swap
// row in place of the two: the source leg is the row's own asset and amount,
// the output leg is `swapOut`, and the row's status, review and funds fields
// are the output note's.
//
// The output is identified by its chain and label (a label names one deposit
// lineage), never by tx hash alone: a batch can put a stranger's row under the
// same hash, and that row stays as it is.
//
// PURE module (no react-native imports) so it is bun-testable.

import type { Transaction } from '@/components/pools-provider';
import {
  depositRowOutcome,
  projectDepositFunds,
  reviewOutcome,
  swapOutputReviewStatus,
  type FundsProjection,
  type RegistrationStatus,
} from '@/services/funds-state';

/** One leg of a two-leg action, in its own chain and token. */
export type SwapLeg = {
  chainId: number;
  chain: string;
  asset: string;
  tokenAddress: string;
  rawAmount: string;
  tokenAmount: number;
  usdValue: number;
};

/** The output leg of a Swap row. */
export type SwapOutLeg = SwapLeg & {
  /** The tx that created the output note(s); the swap tx itself on one chain. */
  txHash: string;
  /** Output identity, normalized: what folds the output's Deposit rows in. */
  labels: string[];
  commitments: string[];
  /** The labels the swap spent, normalized: what names its own source row. */
  sourceLabels: string[];
  /** Cross-chain, recorded on this device: the receive tx once delivered. */
  deliveryTxHash?: string;
  /** Cross-chain, recorded on this device: not delivered yet. */
  delivering?: boolean;
};

/** Labels and commitments compare as 32-byte hex, whatever their spelling. */
export function hexKey(value: string | null | undefined): string {
  if (!value) return '';
  try {
    return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
  } catch {
    return value.toLowerCase();
  }
}

const sameHash = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function isSwapRow(tx: Pick<Transaction, 'type' | 'swapOut'>): tx is Transaction & { swapOut: SwapOutLeg } {
  return tx.type === 'Swap' && !!tx.swapOut;
}

/** Is `row` a Deposit row of this swap's output? */
export function isSwapOutputRow(row: Pick<Transaction, 'type' | 'chainId' | 'label'>, out: SwapOutLeg): boolean {
  if (row.type !== 'Deposit' || row.chainId !== out.chainId || !row.label) return false;
  return out.labels.includes(hexKey(row.label));
}

/** The Deposit rows (feed or synthesized) that these Swap rows explain. */
function foldedDepositPredicate(swaps: readonly Transaction[]): (row: Transaction) => boolean {
  const outs = swaps.filter(isSwapRow).map((s) => s.swapOut);
  if (outs.length === 0) return () => false;
  return (row) => row.type === 'Deposit' && outs.some((out) => isSwapOutputRow(row, out));
}

/** My rows without the output deposits a Swap row folds in. */
export function withoutFoldedSwapOutputs(rows: readonly Transaction[], swaps: readonly Transaction[]): Transaction[] {
  const folded = foldedDepositPredicate(swaps);
  return rows.filter((row) => !folded(row));
}

/**
 * The All tab: each of my Swap rows takes the place of the feed rows it
 * explains, so All keeps its window and gains nothing. The source row is the
 * feed's spend row for the swap's hash on its chain that carries a label the
 * swap spent (a batch may carry a stranger's withdrawal under the same hash,
 * even under a label of mine after a transfer, so only a unique match counts);
 * an unlabelled row stands in only when it is the hash's only one. The
 * output's Deposit rows go. When no source row is in the window, the first
 * output row stands in.
 */
export function withSwapRows(eventRows: readonly Transaction[], lineageRows: readonly Transaction[]): Transaction[] {
  const swaps = lineageRows.filter(isSwapRow);
  if (swaps.length === 0) return eventRows as Transaction[];
  const replace = new Map<Transaction, Transaction>();
  const drop = new Set<Transaction>();
  for (const swap of swaps) {
    const candidates = eventRows.filter((r) => (r.type === 'Withdrawal' || r.type === 'Transfer')
      && r.chainId === swap.chainId && sameHash(r.txHash, swap.txHash) && !replace.has(r));
    const labelled = candidates.filter((r) => !!r.label && swap.swapOut.sourceLabels.includes(hexKey(r.label)));
    const source = labelled.length === 1 ? labelled[0] : (candidates.length === 1 && !candidates[0].label ? candidates[0] : undefined);
    const outputs = eventRows.filter((r) => isSwapOutputRow(r, swap.swapOut));
    const anchor = source ?? outputs[0];
    if (!anchor) continue;
    replace.set(anchor, swap);
    for (const r of outputs) if (r !== anchor) drop.add(r);
  }
  return eventRows.flatMap((r) => (drop.has(r) ? [] : [replace.get(r) ?? r]));
}

/** A leg of a row: its own, and a Swap row's output. */
export type RowLeg = Pick<Transaction, 'asset' | 'chainId' | 'tokenAddress'>;

/** Does either leg of the row pass? A Swap row is listed under both. */
export function anyLeg(tx: Transaction, pass: (leg: RowLeg) => boolean): boolean {
  if (pass(tx)) return true;
  return isSwapRow(tx) && pass(tx.swapOut);
}

/**
 * The output leg as a Deposit row, for everything that keys on a deposit:
 * ownership, Withdraw / Exit / Export, fully-spent. Spending the output later
 * changes these, never the swap's amounts.
 */
export function swapOutputDepositView(tx: Transaction & { swapOut: SwapOutLeg }): Transaction {
  const out = tx.swapOut;
  return {
    ...tx,
    id: `${tx.id}:out`,
    type: 'Deposit',
    chain: out.chain,
    chainId: out.chainId,
    asset: out.asset,
    tokenAddress: out.tokenAddress,
    rawAmount: out.rawAmount,
    tokenAmount: out.tokenAmount,
    usdValue: out.usdValue,
    txHash: out.txHash,
    label: out.labels[0] ?? null,
    swapOut: undefined,
  };
}

/** One output note as the status projection reads it. */
export type SwapOutputState = {
  noteStatus: string;
  /** This note's association-set leaf is published (session chain only). */
  leafConfirmed: boolean;
};

export type OwnOutputContext = {
  /** The association set has loaded: true only on the session chain. */
  leafReady: boolean;
  registration: RegistrationStatus;
};

export type OwnOutputProjection = {
  reviewStatus: 'approved' | 'pending';
  status: string;
  noteStatus: string;
  funds: FundsProjection | null;
};

/**
 * Status of an own output that has no ASP row yet: a synthesized Deposit, or a
 * Swap row before the feed indexes its output. Only evidence already held
 * locally counts (services/funds-state.ts swapOutputReviewStatus): every
 * output must carry its own approval for the row to read approved.
 */
export function projectOwnOutputs(outputs: readonly SwapOutputState[], ctx: OwnOutputContext): OwnOutputProjection | null {
  const first = outputs[0];
  if (!first) return null;
  const approved = outputs.every((o) => swapOutputReviewStatus(o.noteStatus, o.leafConfirmed) === 'approved');
  const reviewStatus = approved ? 'approved' : 'pending';
  // Each output projected on its own; the least settled speaks for the row,
  // so a rejected second output keeps it at risk.
  const each = outputs.map((o) => {
    const funds = projectDepositFunds({
      reviewStatus,
      noteStatus: o.noteStatus,
      leafReady: ctx.leafReady,
      leafConfirmed: o.leafConfirmed,
      registration: ctx.registration,
      discoveryReady: true,
    });
    return {
      status: depositRowOutcome(o.noteStatus, reviewOutcome(reviewStatus)),
      reviewStatus,
      noteStatus: o.noteStatus,
      ...(funds ? { fundsState: funds.state, fundsReason: funds.reason } : {}),
    };
  });
  const worst = aggregateOutputStatus(each) ?? each[0];
  return {
    reviewStatus,
    status: worst.status,
    noteStatus: worst.noteStatus ?? first.noteStatus,
    funds: worst.fundsState && worst.fundsReason ? { state: worst.fundsState, reason: worst.fundsReason } : null,
  };
}

type OutputStatusFields = Pick<Transaction, 'status' | 'reviewStatus' | 'noteStatus' | 'fundsState' | 'fundsReason'>;

const REVIEW_RANK: Record<string, number> = { declined: 0, poi_required: 1, pending: 2, approved: 3 };
const STATUS_RANK: Record<string, number> = { failed: 0, pending: 1, completed: 2 };
const FUNDS_RANK: Record<string, number> = { at_risk: 0, claim: 1, invisible: 2, ready: 3 };

/**
 * A Swap row's status fields from its output's Deposit rows: the least settled
 * output speaks for the row, so it reads approved only when every output is.
 */
export function aggregateOutputStatus(rows: readonly OutputStatusFields[]): OutputStatusFields | null {
  if (rows.length === 0) return null;
  const pick = <K extends keyof OutputStatusFields>(key: K, rank: Record<string, number>) =>
    rows.reduce<OutputStatusFields>((worst, r) =>
      ((rank[String(r[key])] ?? 99) < (rank[String(worst[key])] ?? 99) ? r : worst), rows[0]);
  const review = pick('reviewStatus', REVIEW_RANK);
  const status = pick('status', STATUS_RANK);
  const funds = rows.some((r) => r.fundsState) ? pick('fundsState', FUNDS_RANK) : null;
  return {
    status: status.status,
    reviewStatus: review.reviewStatus,
    noteStatus: status.noteStatus,
    ...(funds?.fundsState ? { fundsState: funds.fundsState, fundsReason: funds.fundsReason } : {}),
  };
}

/** A row's own leg. */
export function ownLeg(tx: Pick<Transaction, 'chainId' | 'chain' | 'asset' | 'tokenAddress' | 'rawAmount' | 'tokenAmount' | 'usdValue'>): SwapLeg {
  return { chainId: tx.chainId, chain: tx.chain, asset: tx.asset, tokenAddress: tx.tokenAddress, rawAmount: tx.rawAmount, tokenAmount: tx.tokenAmount, usdValue: tx.usdValue };
}

/** The two legs a row shows when it has two, with their captions. A recorded
 *  quote is approximate: a Shield input or a receive-as payout is marked ≈. */
export type RowLegs = {
  from: SwapLeg;
  to: SwapLeg;
  fromCaption: string;
  toCaption: string;
  fromApprox: boolean;
  toApprox: boolean;
};

export function rowLegs(tx: Transaction): RowLegs | null {
  if (isSwapRow(tx)) {
    // A stranger's swap (services/swap-route-evidence.ts) is not "yours".
    const own = !!tx.isLineageSynthetic;
    const toCaption = tx.swapOut.delivering ? 'You receive' : own ? 'You received' : 'Received';
    return { from: ownLeg(tx), to: tx.swapOut, fromCaption: own ? 'You swapped' : 'Swapped', toCaption, fromApprox: false, toApprox: false };
  }
  if (tx.type === 'Withdrawal' && tx.receivedAs) {
    return { from: ownLeg(tx), to: tx.receivedAs, fromCaption: 'You withdrew', toCaption: 'Received as', fromApprox: false, toApprox: true };
  }
  if (tx.type === 'Deposit' && tx.swappedFrom) {
    // LI.FI's quoted fromAmount, not an observed wallet balance change.
    return { from: tx.swappedFrom, to: ownLeg(tx), fromCaption: 'Paid from wallet', toCaption: 'Deposited', fromApprox: true, toApprox: false };
  }
  return null;
}

/**
 * My own deposit the ASP tags as funded out of a pool on another network: a
 * swap made elsewhere arrived here. 'pool' (same chain) is a Swap row's
 * output and folds into it; 'wallet' and 'bridged_wallet' say who paid, not
 * that the token changed. A device with the Shield record shows what paid.
 * The tag comes from the ASP's LI.FI lookup, not from either chain's events,
 * so a stranger's row does not show it.
 */
export function fundedBySwap(tx: Pick<Transaction, 'type' | 'fundingSource' | 'swappedFrom'>, isMine: boolean): boolean {
  return isMine && tx.type === 'Deposit' && tx.fundingSource === 'bridged_pool' && !tx.swappedFrom;
}

/** Did this row's value go through a LI.FI swap route? */
export function viaSwapRoute(tx: Transaction): boolean {
  return isSwapRow(tx) || (tx.type === 'Withdrawal' && (!!tx.receivedAs || !!tx.delivery || !!tx.viaSwap));
}

/** Each leg of a row with two legs as text, marked ≈ when it is a
 *  quote; null for any other row. */
export function swapLegTexts(tx: Transaction, format: (leg: SwapLeg) => string): { from: string; to: string } | null {
  const legs = rowLegs(tx);
  if (!legs) return null;
  const text = (leg: SwapLeg, approx: boolean) => {
    const value = format(leg);
    return approx && !value.startsWith('\u2248') ? `\u2248 ${value}` : value;
  };
  return { from: text(legs.from, legs.fromApprox), to: text(legs.to, legs.toApprox) };
}

/** "0.5 ETH → 1250 USDC" for a row with two legs, null for any other row. */
export function swapHeadline(tx: Transaction, format: (leg: SwapLeg) => string): string | null {
  const legs = swapLegTexts(tx, format);
  return legs && `${legs.from} \u2192 ${legs.to}`;
}

/** Pending status copy for a Swap row: shown only while its own output waits. */
export const SWAP_PENDING_COPY = 'Swap pending. The new note waits for ASP approval like any deposit';

/** A cross-chain swap not delivered yet: the far leg is its own, later event. */
export const SWAP_DELIVERING_COPY = 'Delivering. The swap lands on the other network in a few minutes';

export function swapPendingLabel(tx: Pick<Transaction, 'type' | 'status' | 'swapOut'>): string | null {
  if (!isSwapRow(tx) || tx.status !== 'pending') return null;
  return tx.swapOut.delivering ? SWAP_DELIVERING_COPY : SWAP_PENDING_COPY;
}

/**
 * A row as a debug snapshot may record it: without the swap's output identity
 * or pairing. The source leg is the spend's own public row.
 */
export function debugSafeRow<T extends { swapOut?: unknown; receivedAs?: unknown; swappedFrom?: unknown; delivery?: unknown; type?: string; isLineageSynthetic?: boolean; recordedRecipient?: boolean; address?: string; fullAddress?: string }>(row: T): Omit<T, 'swapOut' | 'receivedAs' | 'swappedFrom' | 'delivery'> {
  const { swapOut: _swapOut, receivedAs: _receivedAs, swappedFrom: _swappedFrom, delivery: _delivery, ...rest } = row;
  // The counterparty on a lineage row, or a withdrawal recipient copied onto a
  // feed row, is this device's own record (services/transfer-payee.ts,
  // services/withdraw-recipients-core.ts).
  if ((rest.type === 'Withdrawal' || rest.type === 'Transfer') && (rest.isLineageSynthetic || rest.recordedRecipient)) {
    return { ...rest, address: '', fullAddress: '' };
  }
  return rest;
}

/** A spend as a debug snapshot may record it: without its swap outputs or
 *  the labels of the notes it spent. */
export function debugSafeSpend<T extends { swapOutputs?: unknown; inputLabels?: unknown }>(spend: T): Omit<T, 'swapOutputs' | 'inputLabels'> {
  const { swapOutputs: _swapOutputs, inputLabels: _inputLabels, ...rest } = spend;
  return rest;
}
