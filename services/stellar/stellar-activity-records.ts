/**
 * This device's own record of two Stellar actions the chain cannot attribute
 * to the account doing them (DEV-501):
 *
 *   deposit-for  a deposit this account made FOR another account. Its note is
 *                the recipient's, so the depositor holds nothing that proves
 *                it, and without this record the payment is not in their
 *                activity at all (or, on a browser that also held the
 *                recipient's session, it read as a received transfer).
 *                Only the tx hash is kept, as on EVM
 *                (services/outgoing-deposits-core.ts): no recipient and no
 *                amount, so the device holds no funder-to-recipient link. The
 *                amount is read from the deposit's own event on chain.
 *   claimed      notes imported from a one-time link. They are on chain
 *                already; until the next sync clock indexes them they had no
 *                origin, so the receipt was missing or read as pending.
 *
 * Same decision as the sent-claims store (stellar-sent-claims.ts): local,
 * environment scoped, per device. Nothing here is ever sent anywhere.
 * Pure (storage injected) so it is bun-testable.
 */

export type StellarDepositFor = {
  /** Depositor account (G...). */
  depositor: string;
  txHash: string;
  /** ms */
  createdAt: number;
};

export type StellarClaimedNote = {
  /** Account that claimed (G...). */
  owner: string;
  commitment: string;
  /** The transfer that created the note. */
  txHash: string;
  /** ms */
  claimedAt: number;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** Environment-scoped by the caller (config/app-environment.ts envScopedStorageKey). */
export const DEPOSITS_FOR_BASE_KEY = 'ppv2_stellar_deposits_for_v1';
export const CLAIMED_NOTES_BASE_KEY = 'ppv2_stellar_claimed_notes_v1';

/** Bounded so a long-lived device cannot grow either list without limit. */
export const MAX_RECORDS = 500;

// Same shape as services/outgoing-deposits-store.ts: a revision counter so a
// render can subscribe (useSyncExternalStore) and pick up a new record at once.
let recordsVersion = 0;
const recordsListeners = new Set<() => void>();

export function subscribeStellarActivityRecords(listener: () => void): () => void {
  recordsListeners.add(listener);
  return () => { recordsListeners.delete(listener); };
}

export function getStellarActivityRecordsVersion(): number {
  return recordsVersion;
}

function notifyRecordsChanged(): void {
  recordsVersion += 1;
  for (const listener of recordsListeners) listener();
}

function readList<T>(storage: StorageLike | null, key: string, valid: (v: unknown) => v is T): T[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter(valid) : [];
  } catch {
    return [];
  }
}

function writeList<T>(storage: StorageLike | null, key: string, list: T[]): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(list.length > MAX_RECORDS ? list.slice(list.length - MAX_RECORDS) : list));
    notifyRecordsChanged();
  } catch {
    // Best effort: a missing record only costs the row its label.
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function isDepositFor(v: unknown): v is StellarDepositFor {
  const d = v as Record<string, unknown> | null;
  return !!d && isStr(d.depositor) && isStr(d.txHash) && typeof d.createdAt === 'number';
}

function isClaimed(v: unknown): v is StellarClaimedNote {
  const d = v as Record<string, unknown> | null;
  return !!d && isStr(d.owner) && isStr(d.commitment) && isStr(d.txHash) && typeof d.claimedAt === 'number';
}

const canonicalTx = (v: string) => String(v ?? '').toLowerCase().replace(/^0x/, '');
const canonicalCommitment = (v: string) => {
  try { return BigInt(v).toString(16); } catch { return String(v).toLowerCase(); }
};

export function readDepositsFor(storage: StorageLike | null, key: string, depositor?: string): StellarDepositFor[] {
  // Known fields only: anything else (a recipient, an amount) must not
  // survive a round trip through storage.
  const all = readList(storage, key, isDepositFor).map((d) => ({ depositor: d.depositor, txHash: d.txHash, createdAt: d.createdAt }));
  return depositor ? all.filter((d) => d.depositor === depositor) : all;
}

/** Replace by tx hash; newest last. */
export function recordDepositFor(storage: StorageLike | null, key: string, entry: StellarDepositFor): void {
  const rest = readDepositsFor(storage, key).filter((d) => canonicalTx(d.txHash) !== canonicalTx(entry.txHash));
  writeList(storage, key, [...rest, entry]);
}

export function readClaimedNotes(storage: StorageLike | null, key: string, owner?: string): StellarClaimedNote[] {
  const all = readList(storage, key, isClaimed);
  return owner ? all.filter((c) => c.owner === owner) : all;
}

/** Keeps the first claim time of a note claimed twice. */
export function recordClaimedNotes(storage: StorageLike | null, key: string, entries: readonly StellarClaimedNote[]): void {
  const current = readClaimedNotes(storage, key);
  const held = new Set(current.map((c) => `${c.owner}:${canonicalCommitment(c.commitment)}`));
  const added = entries.filter((e) => !held.has(`${e.owner}:${canonicalCommitment(e.commitment)}`));
  if (added.length === 0) return;
  writeList(storage, key, [...current, ...added]);
}
