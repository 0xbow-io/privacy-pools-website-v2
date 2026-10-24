import { displayTokenSymbol, shareCountLabel } from '@/services/share-display';
import { formatTokenBalance } from '@/services/token-format';
// Pure pending→settled transition detection for the in-app status toasts.
// No store/network/RN imports so it stays unit-testable under the bun runner;
// the headless StatusNotifier component wires it to the live activity feed.

export type NotificationVariant = 'success' | 'destructive' | 'warning';

/**
 * The minimal transaction shape the detector needs — a structural subset of the
 * pools-provider `Transaction`, so tests can hand in plain objects. `status`
 * should be the field that actually settles asynchronously for the type being
 * watched (for deposits, the ASP `reviewStatus`).
 */
export type TransitionTx = {
  id: string;
  type: string;
  status: string;
  tokenAmount: number;
  asset: string;
  timestamp: number;
  chainId?: number;
  tokenAddress?: string;
};

export type NotificationEvent = {
  /** Stable per-transition id (txId + settled status) so re-observing the same
   *  transition never double-fires a toast. */
  id: string;
  txId: string;
  /** Base transaction type ("Deposit"/"Withdrawal"/"Transfer"/"Exit") so a
   *  consumer can scope which transitions it surfaces — e.g. only the async
   *  deposit approval, since the other flows settle synchronously in-flow. */
  baseType: string;
  title: string;
  description: string;
  variant: NotificationVariant;
  timestamp: number;
};

const FAILURE_STATUSES = new Set(['failed', 'rejected', 'declined', 'error', 'cancelled']);

const isPending = (status: string): boolean => status.toLowerCase() === 'pending';

// Proof of Innocence demanded: the ASP has spoken, but the review is not over.
// Announced once (as a warning), then kept OPEN so the eventual approval or
// decline still emits, unlike terminal states which are sticky.
const isPoiRequired = (status: string): boolean => status.toLowerCase() === 'poi_required';
const isOpen = (status: string): boolean => isPending(status) || isPoiRequired(status);

/** "0.50 ETH" / "26 USDC": the shared balance format (formatTokenBalance). */
function formatAmount(value: number, asset: string): string {
  return shareCountLabel(formatTokenBalance(value, displayTokenSymbol(asset)), asset);
}

/** Normalize a feed type string to its base form: "deposit" → "Deposit",
 *  "Transfer Out" → "Transfer" (directional suffixes dropped). */
function baseType(type: string): string {
  const t = type.trim().split(/\s+/)[0] ?? '';
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

// The display boundary can supply a rate-aware label; raw transaction amounts
// and transition memory remain in shares. Without it, a share reads as a
// count ("0.10 ETH shares"), never under its own name.
export type TransitionAmountDisplay = (tx: TransitionTx) => string;

/**
 * The user-facing copy for a settled (or failed) transition, keyed off the base
 * transaction type. A deposit "approves" (the ASP clears it); everything else
 * "completes".
 */
export function buildTransitionEvent(tx: TransitionTx, amountDisplay?: TransitionAmountDisplay): NotificationEvent {
  const amount = amountDisplay ? amountDisplay(tx) : formatAmount(tx.tokenAmount, tx.asset);
  const failed = FAILURE_STATUSES.has(tx.status.toLowerCase());
  const base = baseType(tx.type);

  let title: string;
  let description: string;
  if (isPoiRequired(tx.status)) {
    title = 'Proof required';
    description = `. The ASP asks for a Proof of Innocence`;
  } else if (failed) {
    title = base === 'Deposit' ? 'Deposit declined' : `${base} failed`;
    description = amount;
  } else {
    switch (base) {
      case 'Deposit':
        // Approval (ASP review) precedes leaf-backed spendability by a few
        // minutes — say what happened, never "now spendable" (issue #214's
        // approve→leaf lag would make the toast contradict balances).
        title = 'Deposit approved';
        description = amount;
        break;
      case 'Withdrawal':
        title = 'Withdrawal complete';
        description = `${amount} sent`;
        break;
      case 'Transfer':
        title = 'Transfer complete';
        description = `${amount} sent`;
        break;
      case 'Exit':
        title = 'Exit complete';
        description = `${amount} withdrawn`;
        break;
      default:
        title = `${base} complete`;
        description = amount;
    }
  }

  return {
    id: `${tx.id}:${tx.status}`,
    txId: tx.id,
    baseType: base,
    title,
    description,
    variant: failed ? 'destructive' : isPoiRequired(tx.status) ? 'warning' : 'success',
    timestamp: tx.timestamp,
  };
}

/** The fields of an activity row the deposit toasts read. */
export type DepositRowLike = {
  type: string;
  txHash: string;
  chainId: number;
  status: string;
  reviewStatus: string;
  tokenAmount: number;
  asset: string;
  timestamp: number;
  noteStatus?: string;
  ownCommitment?: string;
  tokenAddress?: string;
};

/**
 * The account's deposit rows as transition input, one per transaction.
 *
 * Keyed by the deposit's transaction, not the row: a deposit that leaves the
 * public window comes back as a row built from the event snapshot, under
 * another id, and its review must still announce. A row with no verdict is
 * left out: a snapshot row before its note matches (else a fresh restore
 * would announce every old deposit as approved the moment its note synced),
 * an exited deposit, and one made for someone else. A matched note proves
 * the row mine, whoever submitted the deposit (a cross-chain shield names
 * the bridge executor).
 *
 * The legs of a batch deposit share a transaction and announce as one, with
 * the most decisive leg's outcome, so the answer never depends on row order.
 */
export function depositTransitionTxs<R extends DepositRowLike>(
  rows: readonly R[],
  isOwn: (row: R) => boolean,
): TransitionTx[] {
  const byTx = new Map<string, TransitionTx>();
  for (const row of rows) {
    if (row.type !== 'Deposit' || !row.txHash) continue;
    if (!row.reviewStatus) continue;
    if (!(row.ownCommitment && row.noteStatus) && !isOwn(row)) continue;
    const id = `${row.chainId}:${row.txHash.toLowerCase()}`;
    const tx: TransitionTx = {
      id,
      type: row.type,
      // The row's outcome, with a decline kept as its sharper word for the
      // copy (the feed maps it to 'failed').
      status: row.reviewStatus === 'declined' ? 'declined'
        : row.reviewStatus === 'poi_required' ? 'poi_required'
        : row.status,
      chainId: row.chainId,
      tokenAddress: row.tokenAddress,
      tokenAmount: row.tokenAmount,
      asset: row.asset,
      timestamp: row.timestamp,
    };
    const held = byTx.get(id);
    if (!held || outcomeRank(tx.status) > outcomeRank(held.status)) byTx.set(id, tx);
  }
  return [...byTx.values()];
}

/** Declined, then proof required, then settled, then pending. */
function outcomeRank(status: string): number {
  if (FAILURE_STATUSES.has(status.toLowerCase())) return 3;
  if (isPoiRequired(status)) return 2;
  return isPending(status) ? 0 : 1;
}

// Bound on retained per-tx status entries. Old entries are evicted
// oldest-first once the map exceeds this, so a long session can't grow the
// memory unboundedly while still riding out ordinary feed-window gaps.
const MAX_TRACKED = 1000;

/**
 * Diff the previous per-tx status map against current activity and return the
 * notable transitions (a pending tx that has now settled or failed) plus the
 * updated status map to persist.
 *
 * Monotonic by construction:
 *  - a tx seen for the first time is only recorded (seeded), never emitted,
 *    so a fresh load doesn't replay history as a burst;
 *  - entries are RETAINED when a tx drops out of the (windowed/filtered)
 *    feed, so `pending → absent → settled` still emits on reappearance
 *    instead of being re-seeded as a first sighting;
 *  - terminal (non-pending) states are STICKY: a stale feed page that
 *    momentarily reports `pending` again can't rewind the memory, so the
 *    later re-settle can't emit a duplicate.
 */
export function detectStatusTransitions(
  prev: Record<string, string>,
  current: TransitionTx[],
  amountDisplay?: TransitionAmountDisplay,
): { events: NotificationEvent[]; next: Record<string, string> } {
  // Start from prev so txs absent from the current feed window keep their
  // known state (insertion order = age, used for eviction below).
  const next: Record<string, string> = { ...prev };
  const events: NotificationEvent[] = [];
  for (const tx of current) {
    const before = prev[tx.id];
    if (before === undefined) {
      next[tx.id] = tx.status; // first sighting → seed only
      continue;
    }
    if (!isOpen(before)) continue; // terminal states are sticky
    if (isPending(tx.status)) continue; // still pending. No change
    if (tx.status === before) continue; // still waiting on the proof. No change
    next[tx.id] = tx.status;
    events.push(buildTransitionEvent(tx, amountDisplay));
  }
  // Bounded retention: evict oldest entries beyond the cap.
  const keys = Object.keys(next);
  if (keys.length > MAX_TRACKED) {
    for (const key of keys.slice(0, keys.length - MAX_TRACKED)) delete next[key];
  }
  return { events, next };
}
