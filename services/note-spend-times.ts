/**
 * When each of this account's spent notes was spent, per chain, as unix seconds.
 *
 * Filled after every discovery pass from the bulk note index that pass already
 * built, so recording a spend time costs no request. The provider persists each
 * account's entries beside its note export: a reloaded tab is locked until the
 * user signs in again and cannot derive them, and without them its spent notes
 * read as unknown.
 *
 * One instance per app, hung off globalThis, like services/snapshot-source.ts.
 */

type Listener = () => void;

type Store = {
  byKey: Map<string, Map<string, number>>;
  listeners: Set<Listener>;
};

const STORE_FLAG = '__ppv2NoteSpendTimes';

const store: Store = (() => {
  const existing = (globalThis as Record<string, unknown>)[STORE_FLAG];
  if (existing) return existing as Store;
  const created: Store = { byKey: new Map(), listeners: new Set() };
  (globalThis as Record<string, unknown>)[STORE_FLAG] = created;
  return created;
})();

function keyOf(chainId: number, account: string): string {
  return `${chainId}:${account.toLowerCase()}`;
}

/** Merge spend times for one account on one chain. Commitments are matched lowercased. */
export function recordNoteSpendTimes(chainId: number, account: string, times: ReadonlyMap<string, number>): void {
  if (times.size === 0) return;
  const key = keyOf(chainId, account);
  const target = store.byKey.get(key) ?? new Map<string, number>();
  let changed = false;
  for (const [commitment, seconds] of times) {
    const c = commitment.toLowerCase();
    if (target.get(c) !== seconds) {
      target.set(c, seconds);
      changed = true;
    }
  }
  if (!changed) return;
  store.byKey.set(key, target);
  for (const listener of store.listeners) listener();
}

export function noteSpendTime(chainId: number, account: string, commitment: string): number | null {
  return store.byKey.get(keyOf(chainId, account))?.get(commitment.toLowerCase()) ?? null;
}

/** Fill in persisted spend times without overriding any this page already recorded. */
export function restoreNoteSpendTimes(chainId: number, account: string, times: ReadonlyMap<string, number>): void {
  const existing = store.byKey.get(keyOf(chainId, account));
  const missing = new Map([...times].filter(([commitment]) => !existing?.has(commitment.toLowerCase())));
  recordNoteSpendTimes(chainId, account, missing);
}

/** Every spend time recorded for one account on one chain. */
export function noteSpendTimesFor(chainId: number, account: string): Map<string, number> {
  return new Map(store.byKey.get(keyOf(chainId, account)) ?? []);
}

export function clearNoteSpendTimes(chainId: number, account: string): void {
  if (!store.byKey.delete(keyOf(chainId, account))) return;
  for (const listener of store.listeners) listener();
}

export function subscribeNoteSpendTimes(listener: Listener): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

/**
 * Spend times for `notes`, read from a bulk index: `spentAt` maps a nullifier to
 * the hex timestamp of its spend, or null. Lookups only. ACTIVE notes are
 * included because a pass may be about to mark one SPENT.
 */
export function collectNoteSpendTimes(
  notes: readonly { commitment: string; status: unknown }[],
  nullifierOf: (commitment: string) => string,
  spentAt: (nullifier: string) => string | null,
): Map<string, number> {
  const times = new Map<string, number>();
  for (const note of notes) {
    const status = String(note.status).toUpperCase();
    if (status !== 'SPENT' && status !== 'EXITED' && status !== 'EXIT_PENDING' && status !== 'ACTIVE') continue;
    try {
      const at = spentAt(nullifierOf(note.commitment));
      if (at) times.set(note.commitment, Number(BigInt(at)));
    } catch {
      // No spend time: points report the note as unknown, never as held.
    }
  }
  return times;
}

export function serializeNoteSpendTimes(times: ReadonlyMap<string, number>): string {
  return JSON.stringify(Object.fromEntries(times));
}

/** A persisted value back into spend times; anything malformed is dropped. */
export function parseStoredNoteSpendTimes(raw: string | null): Map<string, number> {
  const times = new Map<string, number>();
  if (!raw) return times;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return times;
    for (const [commitment, seconds] of Object.entries(parsed)) {
      if (/^0x[0-9a-fA-F]+$/.test(commitment) && Number.isSafeInteger(seconds) && (seconds as number) > 0) {
        times.set(commitment.toLowerCase(), seconds as number);
      }
    }
  } catch {
    // Unreadable: nothing restored, the next discovery pass records them again.
  }
  return times;
}
