// Pure half of services/pending-relays-store.ts: which relayed spends this
// device handed to a relayer that have not been seen on-chain yet.
//
// A relayer that returns a hash has only broadcast the transaction. With a low
// tip it can sit in the mempool for minutes and then land, and the flows used
// to call that "failed" at the end of their receipt wait and let the user build
// a second spend of the same notes (DEV-458). The second spend can never land,
// but the relayer signs and pays for it, and the user reads three failures for
// a transfer that went through.
//
// A record is keyed by the proof's nullifiers, read from the relay request
// itself. It stays until those nullifiers are seen spent (in a receipt, the
// bulk index, or the event snapshot every client polls anyway), until the
// relayed transaction is seen reverted, or until it expires. Nothing here is
// sent anywhere: matching is done against data the client already has.

import type { SnapshotTransact } from '@/services/api-types';

export type PendingRelay = {
  id: string;
  chainId: number;
  /** Relayer interactor method that returned the hash (relayTransfer, relayWithdrawal…). */
  method: string;
  /** Lowercase nullifier hashes the proof spends. */
  nullifiers: string[];
  /** Lowercase hash the relayer returned. */
  txHash: string;
  /** Lowercase session address the relay was made under, when known. */
  owner: string | null;
  /** unix ms the relayer returned the hash */
  at: number;
  /** unix ms the user chose to send again anyway; the record no longer blocks. */
  overriddenAt?: number;
};

export type PendingRelayResolution = {
  record: PendingRelay;
  /** The nullifiers were spent; false only for a seen revert of this relay. */
  spent: boolean;
  /** The transaction that spent them, when known. A snapshot row can lack its hash. */
  spentBy: string | null;
  /** spentBy is the hash this record's relayer returned. */
  ownHash: boolean;
};

/** A different, known transaction spent this record's notes (an earlier attempt, another device). */
export function settledByOtherSpend(resolution: PendingRelayResolution): boolean {
  return resolution.spent && resolution.spentBy !== null && !resolution.ownHash;
}

/**
 * The hash this record landed as, or null when it did not land (reverted, or
 * another known transaction spent its notes). A spend seen without a hash is
 * taken as this relay's own: its nullifiers are gone either way, and nothing
 * names a different transaction.
 */
export function landedTxHash(resolution: PendingRelayResolution): string | null {
  if (!resolution.spent || settledByOtherSpend(resolution)) return null;
  return resolution.spentBy ?? resolution.record.txHash;
}

/** A relay older than this is dropped. Its proof's roots have long rotated out. */
export const PENDING_RELAY_TTL_MS = 24 * 60 * 60 * 1000;

/** How long a pending relay blocks a new spend of the same notes before the user can override it. */
export const PENDING_RELAY_OVERRIDE_AFTER_MS = 10 * 60 * 1000;

export const MAX_PENDING_RELAYS = 50;

const HASH_RE = /^0x[0-9a-f]{64}$/;
const HEX_RE = /^0x[0-9a-f]+$/;

function normHex(value: unknown): string | null {
  if (typeof value === 'bigint') return `0x${value.toString(16)}`;
  if (typeof value !== 'string') return null;
  const v = value.toLowerCase();
  if (!HEX_RE.test(v)) return null;
  // Same field element whatever the padding: 0x00ab and 0xab are one nullifier.
  const stripped = v.slice(2).replace(/^0+/, '');
  return `0x${stripped === '' ? '0' : stripped}`;
}

export function parsePendingRelays(raw: unknown): PendingRelay[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is PendingRelay => !!r
    && typeof r === 'object'
    && typeof (r as PendingRelay).id === 'string'
    && typeof (r as PendingRelay).chainId === 'number'
    && typeof (r as PendingRelay).method === 'string'
    && Array.isArray((r as PendingRelay).nullifiers)
    && (r as PendingRelay).nullifiers.every((n) => typeof n === 'string')
    && typeof (r as PendingRelay).txHash === 'string'
    && HASH_RE.test((r as PendingRelay).txHash)
    && ((r as PendingRelay).owner === null || typeof (r as PendingRelay).owner === 'string')
    && typeof (r as PendingRelay).at === 'number'
    && ((r as PendingRelay).overriddenAt === undefined || typeof (r as PendingRelay).overriddenAt === 'number'));
}

type ProofCarrier = { proof?: { publicSignals?: unknown }; inputNullifierNumber?: unknown };

function nullifiersOfItem(item: ProofCarrier): string[] {
  const signals = item.proof?.publicSignals;
  const n = item.inputNullifierNumber;
  if (!Array.isArray(signals) || typeof n !== 'number' || n <= 0 || n > signals.length) return [];
  const out: string[] = [];
  for (const s of signals.slice(0, n)) {
    const h = normHex(s);
    if (h && h !== '0x0') out.push(h);
  }
  return out;
}

/**
 * The nullifiers a relay request spends: `proof.publicSignals[0 : inputNullifierNumber]`
 * of every proof it carries. Covers the flat relay params, a batch's `items`,
 * and params that wrap a withdrawal request one level down
 * (register-and-withdrawal, relay-and-announce).
 */
export function relayRequestNullifiers(params: unknown): string[] {
  if (!params || typeof params !== 'object') return [];
  const seen = new Set<string>();
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== 'object' || depth > 2) return;
    for (const n of nullifiersOfItem(node as ProofCarrier)) seen.add(n);
    for (const value of Object.values(node as Record<string, unknown>)) {
      if (Array.isArray(value)) {
        for (const item of value) if (item && typeof item === 'object' && 'proof' in item) visit(item, depth + 1);
      } else if (value && typeof value === 'object' && !('publicSignals' in value)) {
        visit(value, depth + 1);
      }
    }
  };
  visit(params, 0);
  return [...seen];
}

export function withoutExpired(list: readonly PendingRelay[], now: number): PendingRelay[] {
  return list.filter((r) => now - r.at < PENDING_RELAY_TTL_MS);
}

export function addPendingRelay(list: readonly PendingRelay[], entry: PendingRelay, now: number): PendingRelay[] {
  // Compare the NORMALIZED hash: the raw incoming one can differ only in case
  // from an already-stored record (the relayer, or a re-broadcast, is free to
  // return either), and comparing before lowercasing let the same relay land
  // twice under the same id, so settlement published its resolution twice.
  const normalizedHash = entry.txHash.toLowerCase();
  const kept = withoutExpired(list, now).filter((r) => !(r.chainId === entry.chainId && r.txHash === normalizedHash));
  kept.push({
    ...entry,
    txHash: normalizedHash,
    nullifiers: entry.nullifiers.map((n) => normHex(n)).filter((n): n is string => !!n),
    owner: entry.owner ? entry.owner.toLowerCase() : null,
  });
  return kept.length > MAX_PENDING_RELAYS ? kept.slice(kept.length - MAX_PENDING_RELAYS) : kept;
}

/**
 * The pending relay that stops a new spend of `nullifiers`, if any: one on the
 * same chain that shares a nullifier and has not been overridden. The newest
 * wins, so the caller names the latest attempt.
 */
export function findBlockingRelay(
  list: readonly PendingRelay[],
  chainId: number,
  nullifiers: readonly string[],
  now: number,
): PendingRelay | null {
  const want = new Set(nullifiers.map((n) => normHex(n)).filter((n): n is string => !!n));
  if (want.size === 0) return null;
  let best: PendingRelay | null = null;
  for (const r of withoutExpired(list, now)) {
    if (r.chainId !== chainId || r.overriddenAt !== undefined) continue;
    if (!r.nullifiers.some((n) => want.has(n))) continue;
    if (!best || r.at > best.at) best = r;
  }
  return best;
}

export function canOverride(record: PendingRelay, now: number): boolean {
  return now - record.at >= PENDING_RELAY_OVERRIDE_AFTER_MS;
}

/**
 * Settle every record on `chainId` that one of `spends` accounts for: a spend
 * that consumed any of a record's nullifiers used the same notes, so that
 * record can never land as sent (or it just did). Returns what is left and
 * what was settled.
 */
export function settleBySpends(
  list: readonly PendingRelay[],
  chainId: number,
  spends: readonly { txHash: string | null; nullifiers: readonly string[] }[],
): { kept: PendingRelay[]; settled: PendingRelayResolution[] } {
  const spentBy = new Map<string, string | null>();
  for (const s of spends) {
    const tx = s.txHash ? s.txHash.toLowerCase() : null;
    for (const n of s.nullifiers) {
      const h = normHex(n);
      if (h) spentBy.set(h, tx);
    }
  }
  const kept: PendingRelay[] = [];
  const settled: PendingRelayResolution[] = [];
  for (const r of list) {
    if (r.chainId !== chainId) { kept.push(r); continue; }
    const hit = r.nullifiers.find((n) => spentBy.has(n));
    if (hit === undefined) { kept.push(r); continue; }
    const tx = spentBy.get(hit) ?? null;
    settled.push({ record: r, spent: true, spentBy: tx, ownHash: tx !== null && tx === r.txHash });
  }
  return { kept, settled };
}

/** The snapshot's transacts, as spends settleBySpends reads. */
export function spendsFromSnapshot(transacts: readonly Pick<SnapshotTransact, 'txHash' | 'nullifierHashes'>[]): { txHash: string | null; nullifiers: readonly string[] }[] {
  return transacts.map((t) => ({ txHash: t.txHash ? String(t.txHash) : null, nullifiers: t.nullifierHashes ?? [] }));
}

/**
 * Settle the record whose relayed hash mined: `status` true means it spent its
 * nullifiers, false means it reverted and spent nothing. Either way it is no
 * longer pending.
 */
export function settleByReceipt(
  list: readonly PendingRelay[],
  txHash: string,
  status: boolean,
): { kept: PendingRelay[]; settled: PendingRelayResolution[] } {
  const want = txHash.toLowerCase();
  const kept: PendingRelay[] = [];
  const settled: PendingRelayResolution[] = [];
  for (const r of list) {
    if (r.txHash !== want) { kept.push(r); continue; }
    settled.push({ record: r, spent: status, spentBy: status ? want : null, ownHash: status });
  }
  return { kept, settled };
}

export function overrideRelay(list: readonly PendingRelay[], id: string, now: number): PendingRelay[] {
  return list.map((r) => (r.id === id ? { ...r, overriddenAt: now } : r));
}

/** No hash or nullifier in the message: errors get logged and reported. */
export class PendingRelayBlockedError extends Error {
  readonly record: PendingRelay;
  constructor(record: PendingRelay, now = Date.now()) {
    const minutes = Math.max(1, Math.round((now - record.at) / 60_000));
    super(
      `A transaction spending these funds was sent through the relayer ${minutes} min ago and has not confirmed yet. `
      + 'It can still land, so sending again now would only fail. Your balance updates on its own once it settles.'
      + (canOverride(record, now) ? ' If you believe it was dropped, choose "Send anyway" in the pending notice.' : ''),
    );
    this.name = 'PendingRelayBlockedError';
    this.record = record;
  }
}

export function isPendingRelayBlocked(message: string): boolean {
  return /has not confirmed yet\. It can still land/.test(message);
}
