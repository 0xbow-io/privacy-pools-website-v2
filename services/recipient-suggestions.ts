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
