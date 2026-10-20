// Storage half of services/pending-relays-core.ts. Web localStorage, native
// SecureStore, env-scoped key, same as own-actions-store. A record is deleted
// the moment it settles, so what stays on disk is only what is still in flight.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { envScopedStorageKey } from '@/config/app-environment';
import {
  addPendingRelay,
  findBlockingRelay,
  overrideRelay,
  parsePendingRelays,
  PendingRelayBlockedError,
  PENDING_RELAY_TTL_MS,
  settleByReceipt,
  settleBySpends,
  withoutExpired,
  type PendingRelay,
  type PendingRelayResolution,
} from '@/services/pending-relays-core';

export type { PendingRelay, PendingRelayResolution };

const STORAGE_KEY = envScopedStorageKey('ppv2_pending_relays_v1');

function storageGetItem(key: string): string | null {
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage === 'undefined') return null;
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  try {
    return SecureStore.getItem(key);
  } catch {
    return null;
  }
}

// Every native mutation (delete-on-settle, set-on-record) is chained through
// this one promise, in the order storageWrite was called. SecureStore's
// delete is async while its set is sync, so without this an immediate
// record-after-settle could reach the keychain before the settle's delete
// did, and the delete would then land AFTER it and erase the new record —
// or a synchronous retry's readAll() would still see the just-settled relay
// because the delete had not landed yet either way.
let nativeWriteQueue: Promise<void> = Promise.resolve();

function storageWrite(key: string, value: string | null): void {
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage === 'undefined') return;
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (err) {
      console.warn('[pending-relays-store] write failed', err);
    }
    return;
  }
  nativeWriteQueue = nativeWriteQueue
    .then(() => (value === null ? SecureStore.deleteItemAsync(key) : SecureStore.setItemAsync(key, value)))
    .catch((err) => { console.warn('[pending-relays-store] write failed', err); });
}

const EMPTY: readonly PendingRelay[] = Object.freeze([]);
let snapshot: readonly PendingRelay[] | null = null;
const listeners = new Set<() => void>();
const settledListeners = new Set<(resolution: PendingRelayResolution) => void>();

function readAll(now = Date.now()): PendingRelay[] {
  try {
    const raw = storageGetItem(STORAGE_KEY);
    return raw ? withoutExpired(parsePendingRelays(JSON.parse(raw)), now) : [];
  } catch {
    return [];
  }
}

function writeAll(list: readonly PendingRelay[]): void {
  storageWrite(STORAGE_KEY, list.length === 0 ? null : JSON.stringify(list));
  snapshot = list.length === 0 ? EMPTY : Object.freeze([...list]);
  for (const listener of listeners) listener();
}

function announceSettled(settled: readonly PendingRelayResolution[]): void {
  for (const resolution of settled) {
    for (const listener of settledListeners) {
      try { listener(resolution); } catch { /* a listener must not stop the others */ }
    }
  }
}

// Whichever tab sees a spend first settles the record for all of them, so the
// others hear it here. Messages only, nothing kept.
const channel: BroadcastChannel | null = (() => {
  if (Platform.OS !== 'web' || typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(STORAGE_KEY);
  } catch {
    return null;
  }
})();

function parseResolutions(raw: unknown): PendingRelayResolution[] {
  if (!Array.isArray(raw)) return [];
  const out: PendingRelayResolution[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<PendingRelayResolution>;
    const [record] = parsePendingRelays([r.record]);
    if (!record || typeof r.spent !== 'boolean' || typeof r.ownHash !== 'boolean') continue;
    if (r.spentBy !== null && typeof r.spentBy !== 'string') continue;
    out.push({ record, spent: r.spent, spentBy: r.spentBy ?? null, ownHash: r.ownHash });
  }
  return out;
}

if (channel) {
  channel.onmessage = (event: MessageEvent) => {
    const settled = parseResolutions(event.data);
    if (settled.length === 0) return;
    snapshot = null;
    for (const listener of listeners) listener();
    announceSettled(settled);
  };
}

function publishSettled(settled: readonly PendingRelayResolution[]): void {
  announceSettled(settled);
  try { channel?.postMessage(settled); } catch { /* other tabs catch up from their own snapshot */ }
}

// Another tab recording or settling a relay changes what this one should show.
if (Platform.OS === 'web' && typeof window !== 'undefined') {
  try {
    window.addEventListener('storage', (event) => {
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      snapshot = null;
      for (const listener of listeners) listener();
    });
  } catch { /* no window events: this tab only sees its own writes */ }
}

let currentOwner: string | null = null;

/** The session address new records are tagged with, so the notice shows an account only its own relays. */
export function setPendingRelayOwner(owner: string | null | undefined): void {
  currentOwner = owner ? owner.toLowerCase() : null;
}

/** The owner a relay started under, for callers that must capture it before an account switch can race the response. */
export function getPendingRelayOwner(): string | null {
  return currentOwner;
}

const CROSS_TAB_LOCK_NAME = `${STORAGE_KEY}:lock`;

type WebLocks = { request: (name: string, cb: () => void | Promise<void>) => Promise<void> };

/**
 * Serializes a read-modify-write section across every tab of this origin
 * (Web Locks API): two tabs recording or settling relays around the same
 * moment each read the list, and without a lock whichever writes last wins,
 * silently dropping the other tab's record or settlement. Best-effort where
 * Web Locks isn't available (native has no other tab to race; an old
 * browser just keeps today's behavior for that one case).
 */
function withStorageLock(fn: () => void): void {
  const locks: WebLocks | undefined = Platform.OS === 'web' && typeof navigator !== 'undefined' && 'locks' in navigator
    ? (navigator as unknown as { locks: WebLocks }).locks
    : undefined;
  if (!locks) { fn(); return; }
  void locks.request(CROSS_TAB_LOCK_NAME, () => { fn(); })
    .catch((err) => { console.warn('[pending-relays-store] locked mutation failed', err); });
}

export function readPendingRelays(): readonly PendingRelay[] {
  if (snapshot === null) {
    const list = readAll();
    snapshot = list.length === 0 ? EMPTY : Object.freeze(list);
  }
  return snapshot;
}

export function subscribePendingRelays(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Hear each record as it settles: spent (by its own hash or another) or reverted. */
export function onPendingRelaySettled(listener: (resolution: PendingRelayResolution) => void): () => void {
  settledListeners.add(listener);
  return () => { settledListeners.delete(listener); };
}

export function recordPendingRelay(entry: { chainId: number; method: string; nullifiers: readonly string[]; txHash: string }): void {
  if (entry.nullifiers.length === 0) return;
  withStorageLock(() => {
    const now = Date.now();
    const id = `${entry.chainId}:${entry.txHash.toLowerCase()}`;
    writeAll(addPendingRelay(readAll(now), { ...entry, nullifiers: [...entry.nullifiers], id, owner: currentOwner, at: now }, now));
  });
}

/** Throws PendingRelayBlockedError when an earlier relay of any of these nullifiers is still in flight. */
export function assertNoPendingRelay(chainId: number, nullifiers: readonly string[]): void {
  const now = Date.now();
  const blocking = findBlockingRelay(readAll(now), chainId, nullifiers, now)
    ?? findBlockingReservation(chainId, nullifiers, now);
  if (blocking) throw new PendingRelayBlockedError(blocking, now);
}

export function overridePendingRelay(id: string): void {
  withStorageLock(() => { writeAll(overrideRelay(readAll(), id, Date.now())); });
}

/** The relayed transaction mined: spent its nullifiers (true) or reverted (false). */
export function settlePendingRelayByReceipt(txHash: string, status: boolean): void {
  withStorageLock(() => {
    const current = readAll();
    if (current.length === 0) return;
    const { kept, settled } = settleByReceipt(current, txHash, status);
    if (settled.length === 0) return;
    writeAll(kept);
    publishSettled(settled);
  });
}

/** Nullifiers seen spent on `chainId`, from the bulk index or the event snapshot. */
export function settlePendingRelaysBySpends(
  chainId: number,
  spends: readonly { txHash: string | null; nullifiers: readonly string[] }[],
): void {
  withStorageLock(() => {
    const current = readAll();
    if (current.length === 0 || spends.length === 0) return;
    const { kept, settled } = settleBySpends(current, chainId, spends);
    if (settled.length === 0) return;
    writeAll(kept);
    publishSettled(settled);
  });
}

// In-memory reservations: nullifiers a relay is about to submit, from the
// moment it is asked to go out until the relayer answers. Kept off disk on
// purpose — a reservation only needs to outlive one relay call, and every
// concurrent sender making one is in THIS process, so nothing here needs to
// cross a reload or another tab.
type Reservation = { chainId: number; method: string; nullifiers: string[]; owner: string | null; at: number };
const reservations = new Map<string, Reservation>();
let reservationSeq = 0;

/**
 * `now` is accepted for symmetry with findBlockingRelay; reservations never
 * expire on their own — every one is always either committed or released.
 */
function findBlockingReservation(chainId: number, nullifiers: readonly string[], _now: number): PendingRelay | null {
  const want = new Set(nullifiers);
  let bestId: string | null = null;
  let best: Reservation | null = null;
  for (const [id, r] of reservations) {
    if (r.chainId !== chainId || !r.nullifiers.some((n) => want.has(n))) continue;
    if (!best || r.at > best.at) { best = r; bestId = id; }
  }
  if (!best || !bestId) return null;
  return { id: bestId, chainId: best.chainId, method: best.method, nullifiers: best.nullifiers, txHash: `0x${'0'.repeat(64)}`, owner: best.owner, at: best.at };
}

/**
 * Reserve `nullifiers` before the relay leaves for the relayer: the
 * assertNoPendingRelay check above is not atomic with recording the relay's
 * hash, so two concurrent sends of the same notes could both pass it before
 * either got a hash back to record. This reservation blocks the second one
 * the moment the first is asked to go out, not only once it returns.
 * Returns the reservation id; commit it with the real hash, or release it if
 * the request never reaches (or is refused by) the relayer.
 */
export function reserveRelayNullifiers(chainId: number, method: string, nullifiers: readonly string[]): string | null {
  if (nullifiers.length === 0) return null;
  const id = `reservation:${chainId}:${++reservationSeq}:${Date.now()}`;
  reservations.set(id, { chainId, method, nullifiers: [...nullifiers], owner: currentOwner, at: Date.now() });
  return id;
}

/** The relayer answered with a hash: replace the reservation with the real record, keeping the owner it started under. */
export function commitRelayReservation(id: string | null, entry: { chainId: number; method: string; nullifiers: readonly string[]; txHash: string }): void {
  const reservation = id ? reservations.get(id) : undefined;
  if (id) reservations.delete(id);
  if (entry.nullifiers.length === 0) return;
  withStorageLock(() => {
    const now = Date.now();
    const recordId = `${entry.chainId}:${entry.txHash.toLowerCase()}`;
    const owner = reservation ? reservation.owner : currentOwner;
    writeAll(addPendingRelay(readAll(now), { ...entry, nullifiers: [...entry.nullifiers], id: recordId, owner, at: now }, now));
  });
}

/** The request never reached the relayer, or was refused by it: release the nullifiers it reserved. */
export function releaseRelayReservation(id: string | null): void {
  if (id) reservations.delete(id);
}

/**
 * Hear settlements of the relays a flow hands over, from the moment each hash
 * returns, so one that settles while the flow is still waiting is not missed.
 * `release` stops everything unless `keep` was called.
 */
export function createPendingRelaySettleWatch() {
  const watches = new Map<string, { settled: Promise<PendingRelayResolution>; stop: () => void }>();
  let kept = false;
  let expiry: ReturnType<typeof setTimeout> | null = null;
  const hear = (txHash: string): Promise<PendingRelayResolution> => {
    const key = txHash.toLowerCase();
    const existing = watches.get(key);
    if (existing) return existing.settled;
    let stop: () => void = () => {};
    const settled = new Promise<PendingRelayResolution>((resolve) => {
      const unsubscribe = onPendingRelaySettled((resolution) => {
        if (resolution.record.txHash !== key) return;
        unsubscribe();
        resolve(resolution);
      });
      stop = unsubscribe;
    });
    watches.set(key, { settled, stop });
    return settled;
  };
  const stopAll = () => {
    if (expiry) { clearTimeout(expiry); expiry = null; }
    for (const w of watches.values()) w.stop();
    watches.clear();
  };
  return {
    hear,
    /** Outlive `release`; stop on its own once a record would have expired. */
    keep: () => {
      kept = true;
      if (!expiry) expiry = setTimeout(stopAll, PENDING_RELAY_TTL_MS);
    },
    stop: stopAll,
    release: () => { if (!kept) stopAll(); },
  };
}
