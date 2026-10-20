/**
 * The sender's durable copy of every Stellar one-time claim it made.
 *
 * A claim link is the recipient's only way to the money, and the send screen
 * is the only place it is shown, so the sender keeps the notes here BEFORE
 * the transfer is broadcast (a tab that dies mid-send still has them) and can
 * rebuild the link from the activity row later. Same decision as the EVM
 * sent-audit store (services/audit-store.ts): localStorage, environment
 * scoped, per device.
 *
 * Pure (storage injected) so it is bun-testable.
 */
import type { StellarClaimNote } from '@/services/stellar/stellar-claim';

export type StellarSentClaim = {
  id: string;
  /** Sender account (G...). */
  sender: string;
  /** Recipient account (G...). */
  recipient: string;
  /** Base units, decimal string. */
  amount: string;
  notes: StellarClaimNote[];
  /** Null until the transfer is confirmed (or matched by its outputs). */
  txHash: string | null;
  createdAt: number;
};

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** Environment-scoped by the caller (config/app-environment.ts envScopedStorageKey). */
export const SENT_CLAIMS_BASE_KEY = 'ppv2_stellar_sent_claims_v1';

function canonicalTx(value: string): string {
  return String(value ?? '').toLowerCase().replace(/^0x/, '');
}

function canonicalCommitment(value: string): string {
  try { return BigInt(value).toString(16); } catch { return String(value).toLowerCase(); }
}

export function readSentClaims(storage: StorageLike | null, key: string): StellarSentClaim[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as StellarSentClaim[]) : [];
  } catch {
    return [];
  }
}

/**
 * The stored list, or null when it exists but cannot be read: a writer must
 * then leave it alone rather than replace every saved link with one.
 */
function readSentClaimsStrict(storage: StorageLike, key: string): StellarSentClaim[] | null {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as StellarSentClaim[]) : null;
  } catch {
    return null;
  }
}

/** Throws when the write is refused: the caller must not broadcast without a saved copy. */
export function saveSentClaim(storage: StorageLike | null, key: string, claim: StellarSentClaim): void {
  if (!storage) throw new Error('This browser cannot save the claim link. Nothing was sent.');
  const current = readSentClaimsStrict(storage, key);
  if (current === null) throw new Error('Saved claim links on this browser could not be read. Nothing was sent.');
  const rest = current.filter((c) => c.id !== claim.id);
  storage.setItem(key, JSON.stringify([claim, ...rest]));
  const back = readSentClaims(storage, key).find((c) => c.id === claim.id);
  if (!back || back.notes.length !== claim.notes.length) {
    throw new Error('This browser cannot save the claim link. Nothing was sent.');
  }
}

export function setSentClaimTx(storage: StorageLike | null, key: string, id: string, txHash: string): void {
  if (!storage) return;
  try {
    const all = readSentClaimsStrict(storage, key);
    if (all === null) return;
    const next = all.map((c) => (c.id === id ? { ...c, txHash } : c));
    storage.setItem(key, JSON.stringify(next));
  } catch {
    // The row lookup also matches by output commitment (findSentClaim).
  }
}

/**
 * The claim a sent transfer made: by tx hash, or (for one whose confirmation
 * was never recorded) by a recipient note among the transfer's outputs.
 */
export function findSentClaim(
  claims: readonly StellarSentClaim[],
  sender: string,
  tx: { txHash: string; outputCommitments?: readonly string[] },
): StellarSentClaim | null {
  const mine = claims.filter((c) => c.sender === sender);
  const byTx = mine.find((c) => c.txHash && canonicalTx(c.txHash) === canonicalTx(tx.txHash));
  if (byTx) return byTx;
  const outputs = new Set((tx.outputCommitments ?? []).map(canonicalCommitment));
  if (outputs.size === 0) return null;
  return mine.find((c) => !c.txHash && c.notes.some((n) => outputs.has(canonicalCommitment(n.commitment)))) ?? null;
}
