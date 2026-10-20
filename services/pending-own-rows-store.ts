// In-memory ledger of this client's operations that the activity feed does
// not describe yet (services/feed-reconciliation.ts has the rule and the why).
//
// Deliberately NOT persisted: the entry stands in for a row the ASP will
// produce within seconds of the transaction being mined, and a reload after
// that has the real row. Persisting it would only let a stale optimistic row
// outlive the session that could vouch for it. It replaces an optimistic row
// that used to be written into the `globalEvents` react-query cache, which a
// refetch dropped and a second feed source could duplicate.
//
// Consumers subscribe through useSyncExternalStore; the snapshot is an
// immutable array replaced on every change, so the reference is stable.
import type { GlobalEvent } from '@/services/api-types';
import {
  removePendingOwnRowFrom,
  upsertPendingOwnRow,
  withoutPendingOwnRows,
  type PendingOwnRow,
} from '@/services/feed-reconciliation';

const EMPTY: readonly PendingOwnRow<GlobalEvent>[] = Object.freeze([]);

let rows: readonly PendingOwnRow<GlobalEvent>[] = EMPTY;
const listeners = new Set<() => void>();

function publish(next: readonly PendingOwnRow<GlobalEvent>[]): void {
  if (next === rows) return;
  rows = next.length === 0 ? EMPTY : Object.freeze([...next]);
  for (const listener of listeners) listener();
}

export function subscribePendingOwnRows(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readPendingOwnRows(): readonly PendingOwnRow<GlobalEvent>[] {
  return rows;
}

/** Record an operation this client just broadcast or relayed. */
export function addPendingOwnRow(entry: PendingOwnRow<GlobalEvent>): void {
  publish(upsertPendingOwnRow(rows, entry));
}

/** Forget an operation: it reverted, timed out, or a local row now covers it. */
export function removePendingOwnRow(chainId: number, txHash: string): void {
  const next = removePendingOwnRowFrom(rows, chainId, txHash);
  if (next.length !== rows.length) publish(next);
}

/** Drop the entries the reconciler reported as settled or expired. */
export function prunePendingOwnRows(drop: readonly PendingOwnRow<GlobalEvent>[]): void {
  if (drop.length === 0) return;
  const next = withoutPendingOwnRows(rows, drop);
  if (next.length !== rows.length) publish(next);
}

/** Tests only. */
export function resetPendingOwnRowsForTests(): void {
  publish(EMPTY);
}
