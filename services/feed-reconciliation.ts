/**
 * Local reconciliation of the activity feeds against this client's own
 * pending operations, so the feeds can poll on a fixed cadence while a
 * transaction is in flight.
 *
 * WHY THIS EXISTS
 *
 * Four feeds in pools-provider stopped polling while `txPending`. The ASP saw
 * this client go quiet for exactly the length of every deposit, transfer,
 * withdrawal and ragequit and start again when it settled: a silence window
 * bracketing an on-chain event, which is the 2026-09-10 disclosure's join
 * obtained by absence. The wallet-balance polls had the same gate and were
 * fixed by latching the DISPLAY (services/latched-value.ts). That does not
 * transfer here, because the problem with the feeds was never what is shown
 * but what a row MEANS while our own operation is in flight.
 *
 * Concretely: the deposit flow used to inject an optimistic row into the
 * `globalEvents` react-query cache. That row had a synthetic `eventId` and
 * the real tx hash. With the poll running through the deposit, two things
 * went wrong. A tick replaced the cache wholesale and the row vanished before
 * any local note existed to re-synthesize it from. And a second source of
 * our own rows could deliver the same deposit under a different `eventId`
 * while the optimistic row was still in the public cache; the list merge
 * deduped by `eventId`, so one deposit became two rows, two counted deposits.
 * The pause hid both by construction, and a window-focus refetch (TanStack's
 * default, still on) could reproduce both at any time.
 *
 * THE RULE
 *
 * Our own pending operation is held LOCALLY (services/pending-own-rows-store.ts),
 * never written into a feed cache. When the feeds are merged, a pending row
 * yields to any feed row describing the same OPERATION, identified as
 *
 *     chainId : txHash (lowercase) : row type
 *
 * and is otherwise shown as ours. Public rows dedupe by the ASP's `eventId`.
 * Our own history rows (services/own-history-rows.ts, built locally from the
 * event snapshot) carry no ASP id, so they yield to any public row for the
 * same operation: inside the window the ASP's row, with its review verdict,
 * is the one shown.
 *
 * WHY THIS KEY, AND WHY IT IS SAFE
 *
 * - The tx hash is the one identifier every party already shares: the ASP puts
 *   it on the row, the chain publishes it, and the flow that broadcast or
 *   relayed the transaction holds it locally the moment the hash is known. No
 *   note secret, commitment, nullifier or label is involved.
 * - Chain-qualified, because the same hash can exist on two chains and the
 *   feeds are a multi-chain aggregate.
 * - Type-qualified, because one tx can legitimately produce two rows of
 *   different kinds: a reshield spends our notes and re-deposits the swapped
 *   value in the SAME tx, so the feed carries a Withdrawal and a Deposit under
 *   one hash and a pending Deposit must not be shadowed by the Withdrawal.
 * - The matching happens over data we already hold: a `Set.has` on the client.
 *   The privacy rules forbid putting a note-derived value or a RELAYED tx hash
 *   on the wire (`waitForTransactionReceipt` on it, a per-label GET). Nothing
 *   here makes a request; the reconciler is pure and takes arrays.
 *
 * Pure and framework-free so bun tests can drive it. The real producer of a
 * pending row, `buildOptimisticDepositEvent`, lives here too so the tests use
 * the same fixture the deposit flow does.
 */

import type { GlobalEvent } from '@/services/api-types';

/** The shape the reconciler needs from a feed row. GlobalEvent satisfies it. */
export type FeedRowLike = {
  eventId?: unknown;
  txHash?: string | null;
  type: string;
  amount?: string;
  /** An own deposit row's output commitment (services/own-history-rows.ts). */
  commitment?: string;
  timestamp: number;
  asset?: { chainId?: unknown };
};

/**
 * One operation this client performed and is waiting for the feed to
 * describe. `row` is what the list shows in the meantime; it is dropped the
 * moment any feed row carries the same operation key.
 */
export type PendingOwnRow<T extends FeedRowLike = GlobalEvent> = {
  chainId: number;
  /** lowercase */
  txHash: string;
  type: T['type'];
  row: T;
  /** unix ms when the flow recorded it */
  recordedAt: number;
};

/** A pending row unresolved this long is not "pending" in any sense the UI can vouch for. */
export const PENDING_OWN_ROW_MAX_AGE_MS = 15 * 60_000;

/** Bounded so a long session cannot grow the ledger without limit. */
export const MAX_PENDING_OWN_ROWS = 50;

const HASH_RE = /^0x[0-9a-f]{64}$/;

/**
 * The identity of an OPERATION as the feed would describe it. Null when the
 * row carries no hash: such a row cannot be matched to anything of ours and
 * is treated as someone else's.
 */
export function operationKey(chainId: unknown, txHash: string | null | undefined, type: string): string | null {
  const cid = Number(chainId);
  const hash = String(txHash ?? '').toLowerCase();
  if (!Number.isFinite(cid) || !hash) return null;
  return `${cid}:${hash}:${type}`;
}

/**
 * The identity of a feed ROW, for deduping the two feed sources against each
 * other. The ASP's `eventId` when it has one; otherwise the operation plus
 * its timestamp, so two rows of a batch deposit (same hash, same type) stay
 * distinct only when the ASP gives them distinct ids.
 */
export function feedRowKey(row: FeedRowLike): string {
  if (row.eventId !== undefined && row.eventId !== null && row.eventId !== '') return `id:${String(row.eventId)}`;
  const cid = Number(row.asset?.chainId);
  return `op:${Number.isFinite(cid) ? cid : ''}:${String(row.txHash ?? '').toLowerCase()}:${row.type}:${row.timestamp}`;
}

export type ReconcileInput<T extends FeedRowLike, O extends FeedRowLike = T> = {
  /** The public, windowed feed (every visible chain flat-mapped). */
  publicRows: readonly T[];
  /** The active account's own history from the event snapshot, or none. */
  ownRows: readonly O[];
  /** Chains the aggregate may show; own rows outside them are dropped. */
  visibleChainIds: ReadonlySet<number>;
  /** This client's operations still waiting for the feed. */
  pendingOwn: readonly PendingOwnRow<T>[];
  /**
   * unix ms, for the pending-row age bound. Omit when calling during a React
   * render (the clock is impure there) and judge expiry off the render path
   * with `expiredPendingOwnRows` instead; nothing expires in that case.
   */
  now?: number;
  maxPendingAgeMs?: number;
};

export type ReconcileResult<T extends FeedRowLike, O extends FeedRowLike = T> = {
  /** Public rows, first occurrence per feed-row key. Order preserved. */
  publicRows: T[];
  /** Own-history rows whose operation `publicRows` does not hold, on visible chains only. */
  ownRows: O[];
  /** Our pending operations the feed does not describe yet. */
  pendingRows: T[];
  /** Pending entries a feed row now describes: the ledger can drop them. */
  settled: PendingOwnRow<T>[];
  /** Pending entries past the age bound: dropped without a feed row. */
  expired: PendingOwnRow<T>[];
};

/**
 * Merge the feed sources and this client's pending operations.
 *
 * Deterministic in the SET of rows whatever order the inputs arrive in: a row
 * that arrives twice, or late, or in the other source first, produces the same
 * result. Only the within-list order follows the inputs, and callers sort by
 * timestamp afterwards anyway.
 */
export function reconcileFeedRows<T extends FeedRowLike, O extends FeedRowLike = T>(input: ReconcileInput<T, O>): ReconcileResult<T, O> {
  const maxAge = input.maxPendingAgeMs ?? PENDING_OWN_ROW_MAX_AGE_MS;
  const seenRows = new Set<string>();
  const seenOperations = new Set<string>();

  const publicRows: T[] = [];
  for (const row of input.publicRows) {
    const key = feedRowKey(row);
    if (seenRows.has(key)) continue;
    seenRows.add(key);
    publicRows.push(row);
    const op = operationKey(row.asset?.chainId, row.txHash, row.type);
    if (op) seenOperations.add(op);
  }

  // Matched leg by leg: a batch deposit is several rows under one operation,
  // and the window's edge can cut through it. Each public leg covers one own
  // leg, one of equal amount first, and the legs no public row covers stay.
  // A public leg takes the commitment of the own leg it covers: its tx hash
  // and label cannot always name my note (a cross-chain swap's note carries
  // the source chain's hash), and the commitment always can.
  const publicLegs = new Map<string, { amount: string; index: number }[]>();
  publicRows.forEach((row, index) => {
    const op = operationKey(row.asset?.chainId, row.txHash, row.type);
    if (op) publicLegs.set(op, [...(publicLegs.get(op) ?? []), { amount: String(row.amount ?? ''), index }]);
  });
  const candidates: { row: O; op: string | null }[] = [];
  for (const row of input.ownRows) {
    const cid = Number(row.asset?.chainId);
    if (Number.isFinite(cid) && !input.visibleChainIds.has(cid)) continue;
    const key = feedRowKey(row);
    if (seenRows.has(key)) continue;
    seenRows.add(key);
    candidates.push({ row, op: operationKey(row.asset?.chainId, row.txHash, row.type) });
  }
  const covered = new Set<number>();
  for (const exact of [true, false]) {
    candidates.forEach(({ row, op }, i) => {
      const legs = op ? publicLegs.get(op) : undefined;
      if (covered.has(i) || !legs?.length) return;
      const leg = exact ? legs.findIndex((l) => l.amount === String(row.amount ?? '')) : 0;
      if (leg < 0) return;
      const [{ index }] = legs.splice(leg, 1);
      if (row.commitment) publicRows[index] = { ...publicRows[index], commitment: row.commitment };
      covered.add(i);
    });
  }
  const ownRows: O[] = [];
  candidates.forEach(({ row, op }, i) => {
    if (covered.has(i)) return;
    ownRows.push(row);
    if (op) seenOperations.add(op);
  });

  const pendingRows: T[] = [];
  const settled: PendingOwnRow<T>[] = [];
  const expired: PendingOwnRow<T>[] = [];
  const seenPending = new Set<string>();
  for (const pending of input.pendingOwn) {
    const op = operationKey(pending.chainId, pending.txHash, pending.type);
    if (!op) continue;
    if (seenOperations.has(op)) {
      settled.push(pending);
      continue;
    }
    if (input.now !== undefined && isExpiredPendingOwnRow(pending, input.now, maxAge)) {
      expired.push(pending);
      continue;
    }
    // Two ledger entries for one operation (a flow re-recorded it) show once.
    if (seenPending.has(op)) continue;
    seenPending.add(op);
    pendingRows.push(pending.row);
  }

  return { publicRows, ownRows, pendingRows, settled, expired };
}

// --- The ledger's pure half -------------------------------------------------

export function isExpiredPendingOwnRow(pending: PendingOwnRow<FeedRowLike>, now: number, maxAgeMs = PENDING_OWN_ROW_MAX_AGE_MS): boolean {
  return now - pending.recordedAt > maxAgeMs;
}

/** The entries past the age bound, for a prune that runs off the render path. */
export function expiredPendingOwnRows<T extends FeedRowLike>(
  list: readonly PendingOwnRow<T>[],
  now: number,
  maxAgeMs = PENDING_OWN_ROW_MAX_AGE_MS,
): PendingOwnRow<T>[] {
  return list.filter((p) => isExpiredPendingOwnRow(p, now, maxAgeMs));
}

/** Latest entry per (chain, hash, type) wins; oldest out past the bound. */
export function upsertPendingOwnRow<T extends FeedRowLike>(
  list: readonly PendingOwnRow<T>[],
  entry: PendingOwnRow<T>,
): PendingOwnRow<T>[] {
  const txHash = entry.txHash.toLowerCase();
  if (!HASH_RE.test(txHash)) return [...list];
  const kept = list.filter((p) => !(p.txHash === txHash && p.chainId === entry.chainId && p.type === entry.type));
  kept.push({ ...entry, txHash });
  return kept.length > MAX_PENDING_OWN_ROWS ? kept.slice(kept.length - MAX_PENDING_OWN_ROWS) : kept;
}

/** Drop every entry for this (chain, hash), whatever its type. */
export function removePendingOwnRowFrom<T extends FeedRowLike>(
  list: readonly PendingOwnRow<T>[],
  chainId: number,
  txHash: string,
): PendingOwnRow<T>[] {
  const needle = txHash.toLowerCase();
  return list.filter((p) => !(p.txHash === needle && p.chainId === chainId));
}

/** Drop exactly these entries (the reconciler's `settled` and `expired`). */
export function withoutPendingOwnRows<T extends FeedRowLike>(
  list: readonly PendingOwnRow<T>[],
  drop: readonly PendingOwnRow<T>[],
): PendingOwnRow<T>[] {
  if (drop.length === 0) return [...list];
  const gone = new Set(drop.map((p) => `${p.chainId}:${p.txHash}:${String(p.type)}`));
  return list.filter((p) => !gone.has(`${p.chainId}:${p.txHash}:${String(p.type)}`));
}

// --- The real producer of a pending deposit row -----------------------------

export type OptimisticDepositInput = {
  chainId: number;
  chainName: string;
  /** The depositing address as the ASP will report it. */
  address: string;
  txHash: string;
  /** Base units, decimal string, exactly as the feed's `amount`. */
  amountRaw: string;
  tokenAddress: string;
  tokenSymbol: string;
  denomination: number;
  /** unix ms */
  now: number;
};

/**
 * The row the deposit flow shows for its own deposit until the ASP indexes
 * it. Same shape as a feed row so every consumer treats it as one; the
 * `eventId` is synthetic (the ASP has not assigned one), which is exactly why
 * the reconciler matches it on the operation key and not on the id.
 */
export function buildOptimisticDepositEvent(input: OptimisticDepositInput): GlobalEvent {
  return {
    type: 'deposit',
    eventId: input.now,
    createdAt: new Date(input.now).toISOString(),
    amount: input.amountRaw,
    address: input.address,
    txHash: input.txHash,
    timestamp: input.now,
    reviewStatus: 'pending',
    asset: {
      asset: input.tokenAddress,
      chainId: input.chainId,
      chainName: input.chainName,
      tokenSymbol: input.tokenSymbol,
      tokenAddress: input.tokenAddress,
      assetAddress: input.tokenAddress,
      denomination: input.denomination,
    },
  };
}

/** A ledger entry for the deposit the flow just broadcast. */
export function pendingDepositRow(input: OptimisticDepositInput): PendingOwnRow<GlobalEvent> {
  return {
    chainId: input.chainId,
    txHash: input.txHash.toLowerCase(),
    type: 'deposit',
    row: buildOptimisticDepositEvent(input),
    recordedAt: input.now,
  };
}

/**
 * The asset a swap-deposit's pending row is filed under: the note's own token
 * and value when the SDK prepared one, the chosen asset otherwise.
 *
 * A swap into ppETH was filed under the plain ETH address, which is the legacy
 * ETH pool on mainnet, so the balance read "pending in ETH (Legacy)" until the
 * feed row replaced it (Mike, 2026-09-24). The SDK's pendingNote already names
 * the share and its share value. Its decimals come from the same lookup as its
 * symbol, and a share the registry does not know falls back rather than guess.
 */
export function swapDepositPendingAsset(
  pendingNote: { tokenId?: string; value?: string } | undefined,
  selected: { address: string; symbol: string; decimals: number; amountRaw: string },
  lookup: (address: string) => { symbol: string; decimals: number } | undefined,
): { tokenAddress: string; tokenSymbol: string; denomination: number; amountRaw: string } {
  const fallback = { tokenAddress: selected.address, tokenSymbol: selected.symbol, denomination: selected.decimals, amountRaw: selected.amountRaw };
  const tokenId = pendingNote?.tokenId;
  if (!tokenId || !pendingNote?.value || tokenId.toLowerCase() === selected.address.toLowerCase()) return fallback;
  const meta = lookup(tokenId);
  if (!meta) return fallback;
  let value: bigint;
  try { value = BigInt(pendingNote.value); } catch { return fallback; }
  if (value <= 0n) return fallback;
  return { tokenAddress: tokenId, tokenSymbol: meta.symbol, denomination: meta.decimals, amountRaw: value.toString() };
}
