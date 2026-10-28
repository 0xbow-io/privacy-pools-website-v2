// The recipient dropdown's list, built only from what this device already
// holds: the payout records written when a withdrawal or a send confirmed here
// (services/withdraw-recipients-store.ts, services/sent-transfers-store.ts,
// device-wide, every account that used this browser), plus the saved contacts.
// Notes themselves carry no recipient, so those records are the local truth
// for "addresses you paid before".
//
// No request of any kind: no RPC, no ASP, no ENS. The result lives in memory
// only and is never written back anywhere.
//
// The records can be long (sent transfers are unbounded), so the index is
// built in chunks with a yield to the host between them, and every chunk can
// publish a partial result: the field renders with what is ready, never waits.
//
// No react-native import: bun-testable.

import { addressFormatOf, canonicalAddress, contactIndex, type AddressFormat, type Contact } from '@/services/address-book-core';

export type PayoutRecord = { address: string; timestamp: number };

export type RecipientIndexEntry = { key: string; address: string; format: AddressFormat; lastUsedAt: number };
export type RecipientIndex = Map<string, RecipientIndexEntry>;

export type RecipientSuggestion = {
  key: string;
  address: string;
  format: AddressFormat;
  name: string | null;
  /** Sort time: last payout, else the day the name was saved. */
  sortAt: number;
};

export const DEFAULT_CHUNK_SIZE = 250;

/** One idle slot (or a macrotask where there is no idle callback). */
export function yieldToHost(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (typeof ric === 'function') ric(() => resolve(), { timeout: 60 });
    else setTimeout(resolve, 0);
  });
}

/** Fold one record into the index (latest use wins). */
function fold(index: RecipientIndex, rec: PayoutRecord): void {
  if (!rec || typeof rec.address !== 'string') return;
  const canon = canonicalAddress(rec.address);
  if (!canon) return;
  const t = typeof rec.timestamp === 'number' && Number.isFinite(rec.timestamp) ? rec.timestamp : 0;
  const prev = index.get(canon.key);
  if (!prev || t > prev.lastUsedAt) index.set(canon.key, { key: canon.key, address: canon.display, format: canon.format, lastUsedAt: t });
}

/**
 * Build the index over every source, `chunkSize` records at a time, awaiting
 * `yieldFn` between chunks. `onPartial` sees the index after each chunk (the
 * same Map, growing). Returns null when `isCancelled` turns true.
 */
export async function buildRecipientIndex(
  sources: readonly (readonly PayoutRecord[])[],
  opts: {
    chunkSize?: number;
    yieldFn?: () => Promise<void>;
    onPartial?: (index: RecipientIndex) => void;
    isCancelled?: () => boolean;
  } = {},
): Promise<RecipientIndex | null> {
  const chunkSize = Math.max(1, opts.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const yieldFn = opts.yieldFn ?? yieldToHost;
  const index: RecipientIndex = new Map();
  for (const source of sources) {
    for (let i = 0; i < source.length; i += chunkSize) {
      if (opts.isCancelled?.()) return null;
      const end = Math.min(source.length, i + chunkSize);
      for (let j = i; j < end; j++) fold(index, source[j]);
      opts.onPartial?.(index);
      await yieldFn();
    }
  }
  return opts.isCancelled?.() ? null : index;
}

function matches(s: RecipientSuggestion, q: string): boolean {
  if (!q) return true;
  if (s.name && s.name.toLowerCase().includes(q)) return true;
  return s.address.toLowerCase().includes(q);
}

/**
 * The rows to show: index plus saved contacts, restricted to the formats the
 * field accepts, filtered by what was typed, most recent first. A field that
 * already holds exactly one entry's address shows nothing (it is chosen).
 */
export function rankRecipientSuggestions(
  index: RecipientIndex | null,
  contacts: readonly Contact[],
  opts: { formats: readonly AddressFormat[]; query: string; limit?: number; exclude?: readonly string[] },
): RecipientSuggestion[] {
  const names = contactIndex(contacts);
  const allowed = new Set(opts.formats);
  const excluded = new Set((opts.exclude ?? []).map((a) => canonicalAddress(a)?.key).filter((k): k is string => !!k));
  const rows = new Map<string, RecipientSuggestion>();
  if (index) {
    for (const e of index.values()) {
      if (!allowed.has(e.format) || excluded.has(e.key)) continue;
      rows.set(e.key, { key: e.key, address: e.address, format: e.format, name: names.get(e.key)?.name ?? null, sortAt: e.lastUsedAt });
    }
  }
  for (const [key, c] of names) {
    if (rows.has(key) || excluded.has(key)) continue;
    const format = addressFormatOf(c.address);
    if (!format || !allowed.has(format)) continue;
    rows.set(key, { key, address: c.address, format, name: c.name, sortAt: c.updatedAt });
  }
  const query = opts.query.trim();
  const exact = canonicalAddress(query);
  if (exact && rows.has(exact.key)) return [];
  const q = query.toLowerCase();
  return Array.from(rows.values())
    .filter((s) => matches(s, q))
    .sort((a, b) => b.sortAt - a.sortAt || a.key.localeCompare(b.key))
    .slice(0, opts.limit ?? 8);
}

/** The slice of an Activity row this reads (components/pools-provider.tsx Transaction). */
export type ActivityRowLike = { type?: string; direction?: string; fullAddress?: string; timestamp?: number; chainId?: number };

/**
 * Past recipients from the "Mine" Activity rows the app already holds in
 * memory (the feed rows attributed to this user plus the note-lineage rows).
 * Reads those rows and nothing else: no request, no per-row lookup.
 *
 * Only Withdrawal rows and outgoing Transfer rows that NAME an address are
 * used. Most feed withdrawals carry no address at all (the public feed does
 * not publish the recipient of a relayed withdrawal), and an address that is
 * one of the app's own contracts (a withdrawal processor, the swap router) is
 * the contract, not the person paid, so those rows are skipped rather than
 * suggested.
 */
export function payoutRecordsFromActivity(
  rows: readonly ActivityRowLike[],
  opts: { contractAddresses?: (chainId: number | undefined) => readonly string[] } = {},
): PayoutRecord[] {
  const out: PayoutRecord[] = [];
  for (const r of rows) {
    const isPayout = r.type === 'Withdrawal' || (r.type === 'Transfer' && r.direction === 'out');
    if (!isPayout || !r.fullAddress) continue;
    const canon = canonicalAddress(r.fullAddress);
    if (!canon) continue;
    const contracts = (opts.contractAddresses?.(r.chainId) ?? []).map((a) => a.toLowerCase());
    if (contracts.includes(canon.key)) continue;
    out.push({ address: r.fullAddress, timestamp: typeof r.timestamp === 'number' ? r.timestamp : 0 });
  }
  return out;
}

/** A copy of `index` with `records` folded in (latest use wins). Synchronous: for small in-memory sets. */
export function withRecords(index: RecipientIndex | null, records: readonly PayoutRecord[]): RecipientIndex | null {
  if (records.length === 0) return index;
  const next: RecipientIndex = new Map(index ?? []);
  for (const rec of records) fold(next, rec);
  return next;
}

export type RecipientListState = 'list' | 'loading' | 'empty' | 'none';

/**
 * What a focused field shows. Rows win as soon as there are any. With none
 * and an empty field: 'loading' while a source has not settled (the device
 * index is still being built, or the Activity rows are still loading), so a
 * not-yet-ready source never reads as "nothing to suggest"; 'empty' once both
 * have settled. Typing with no match shows nothing.
 */
export function recipientListState(opts: { rows: number; query: string; deviceReady: boolean; activityLoading: boolean }): RecipientListState {
  if (opts.rows > 0) return 'list';
  if (opts.query.trim() !== '') return 'none';
  return !opts.deviceReady || opts.activityLoading ? 'loading' : 'empty';
}

/**
 * asp-v2#165: recipients of THIS user's own withdrawals, from data already
 * downloaded in bulk. Two in-memory joins, no request:
 *   - spends: the user's own spends (note-derived), each carrying the
 *     `recipient` of the snapshot logs the user spent into (never another log
 *     that shares the tx hash in a batch);
 *   - feed rows: a public feed Withdrawal row whose (chain, tx hash) is one of
 *     the user's own spends, and only when the feed has exactly one Withdrawal
 *     for that hash (a batch row could be someone else's).
 * The field is optional everywhere: absent, null or malformed means nothing,
 * silently, and the other sources carry on.
 */
export function recipientsFromOwnSpends(opts: {
  spends: readonly { txHash?: string; chainId?: number; kind?: string; blockTimestamp?: string; recipients?: readonly unknown[] }[];
  feedRows?: readonly { type?: string; txHash?: string; chainId?: number; recipient?: unknown; timestamp?: number }[];
  /** The address formats valid on a chain; any valid format when omitted. */
  formatsFor?: (chainId: number | undefined) => readonly AddressFormat[] | undefined;
}): PayoutRecord[] {
  const out: PayoutRecord[] = [];
  const valid = (raw: unknown, chainId: number | undefined): string | null => {
    if (typeof raw !== 'string') return null;
    const canon = canonicalAddress(raw);
    if (!canon) return null;
    const allowed = opts.formatsFor?.(chainId);
    return allowed && !allowed.includes(canon.format) ? null : canon.display;
  };
  const key = (chainId: number | undefined, txHash: string | undefined) => `${chainId ?? ''}|${String(txHash ?? '').toLowerCase()}`;
  const own = new Set<string>();
  for (const s of opts.spends ?? []) {
    if (!s || !s.txHash || s.kind !== 'withdrawal') continue;
    own.add(key(s.chainId, s.txHash));
    const t = s.blockTimestamp ? Date.parse(s.blockTimestamp) : NaN;
    for (const r of Array.isArray(s.recipients) ? s.recipients : []) {
      const address = valid(r, s.chainId);
      if (address) out.push({ address, timestamp: Number.isFinite(t) ? t : 0 });
    }
  }
  if (own.size > 0 && opts.feedRows?.length) {
    const counts = new Map<string, number>();
    for (const row of opts.feedRows) if (row?.type === 'Withdrawal' && row.txHash) counts.set(key(row.chainId, row.txHash), (counts.get(key(row.chainId, row.txHash)) ?? 0) + 1);
    for (const row of opts.feedRows) {
      if (row?.type !== 'Withdrawal' || !row.txHash) continue;
      const k = key(row.chainId, row.txHash);
      if (!own.has(k) || counts.get(k) !== 1) continue;
      const address = valid(row.recipient, row.chainId);
      if (address) out.push({ address, timestamp: typeof row.timestamp === 'number' ? row.timestamp : 0 });
    }
  }
  return out;
}
