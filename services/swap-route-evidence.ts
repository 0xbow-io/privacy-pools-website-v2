import type { Transaction } from '@/components/pools-provider';
import { hexKey, ownLeg } from '@/services/swap-rows';

/**
 * What one chain's own events prove about a tx whose Transacted logs a swap
 * route submitted, read from the event snapshot every client downloads whole.
 * 'swap': one such log and one deposit in the same tx, a pool-to-pool swap.
 * 'withdrawal': no deposit in the tx, so the value left the pool through the
 * route, as a receive-as payout or a cross-chain swap's source leg (the chain
 * cannot tell those apart). No cross-chain or off-chain join, and nothing
 * about who owns either leg.
 */
export type SwapRouteKind = 'swap' | 'withdrawal';

export function txKey(chainId: number, txHash: string): string {
  return `${chainId}:${String(txHash || '').toLowerCase()}`;
}

export function swapRouteKinds(
  snapshot: {
    transacts: readonly { chainId: number; txHash: string; caller: string }[];
    deposits: readonly { chainId: number; txHash: string }[];
  },
  isSwapRouteCaller: (caller: string, chainId: number) => boolean,
): Map<string, SwapRouteKind> {
  const logs = new Map<string, { count: number; allSwap: boolean }>();
  for (const t of snapshot.transacts) {
    const k = txKey(t.chainId, t.txHash);
    const prev = logs.get(k) ?? { count: 0, allSwap: true };
    logs.set(k, { count: prev.count + 1, allSwap: prev.allSwap && isSwapRouteCaller(t.caller, t.chainId) });
  }
  const deposits = new Map<string, number>();
  for (const d of snapshot.deposits) {
    const k = txKey(d.chainId, d.txHash);
    deposits.set(k, (deposits.get(k) ?? 0) + 1);
  }
  const kinds = new Map<string, SwapRouteKind>();
  for (const [k, { count, allSwap }] of logs) {
    if (!allSwap) continue;
    const depositCount = deposits.get(k) ?? 0;
    // A batch of swaps has no way to pair its spends with its deposits.
    if (depositCount === 0) kinds.set(k, 'withdrawal');
    else if (count === 1 && depositCount === 1) kinds.set(k, 'swap');
  }
  return kinds;
}

/** Withdrawal rows whose value the swap route paid out, marked as such. */
export function withSwapRouteWithdrawals(rows: readonly Transaction[], kinds: ReadonlyMap<string, SwapRouteKind>): Transaction[] {
  return rows.map((row) => (row.type === 'Withdrawal' && kinds.get(txKey(row.chainId, row.txHash)) === 'withdrawal' ? { ...row, viaSwap: true } : row));
}

/**
 * The All views: a same-chain swap's feed spend and Deposit rows become
 * one Swap row, as my own swaps' rows do (withSwapRows), so a Swap row there
 * does not single out my own. Only a tx whose two legs are both in the rows
 * and neither is a lineage row: my own swap is already shown by those, and a
 * leg outside the feed window leaves the other as it is.
 */
export function withPublicSwapRows(rows: readonly Transaction[], kinds: ReadonlyMap<string, SwapRouteKind>): Transaction[] {
  const byTx = new Map<string, Transaction[]>();
  for (const row of rows) {
    const k = txKey(row.chainId, row.txHash);
    if (kinds.get(k) === 'swap') byTx.set(k, [...(byTx.get(k) ?? []), row]);
  }
  const replace = new Map<Transaction, Transaction>();
  const drop = new Set<Transaction>();
  for (const group of byTx.values()) {
    // The feed's output-arity heuristic calls a spend with several change
    // notes a Transfer. The route evidence above proves the swap either way.
    const spend = group.find((r) => (r.type === 'Withdrawal' || r.type === 'Transfer') && !r.isLineageSynthetic);
    const deposit = group.find((r) => r.type === 'Deposit');
    if (group.length !== 2 || !spend || !deposit) continue;
    replace.set(spend, publicSwapRow(spend, deposit));
    drop.add(deposit);
  }
  return rows.flatMap((r) => (drop.has(r) ? [] : [replace.get(r) ?? r]));
}

/** A Swap row from the two public legs. Its status, review and fund state
 *  are the output's, as on my own: an output of mine keeps its chips. */
function publicSwapRow(spend: Transaction, deposit: Transaction): Transaction {
  const { status, reviewStatus, noteStatus, fundsState, fundsReason } = deposit;
  return {
    ...spend,
    type: 'Swap',
    address: '',
    fullAddress: '',
    status,
    reviewStatus,
    noteStatus,
    fundsState,
    fundsReason,
    swapOut: {
      ...ownLeg(deposit),
      txHash: deposit.txHash.toLowerCase(),
      labels: deposit.label ? [hexKey(deposit.label)] : [],
      commitments: [],
      sourceLabels: spend.label ? [hexKey(spend.label)] : [],
    },
  };
}
