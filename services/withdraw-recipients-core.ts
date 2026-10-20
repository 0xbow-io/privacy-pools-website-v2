// Pure half of services/withdraw-recipients-store.ts: who THIS device paid
// out to on its own withdrawals. The public feed carries no recipient for
// most withdrawals, so without this the sender's own Withdrawal detail could
// not name where the money went. A public tx hash and the address the user
// typed or connected, both already on chain; nothing derived from a note.
// Display only: never ownership evidence, never in a request or a debug
// snapshot.

const HASH_RE = /^0x[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** Bounded so a long-lived device cannot grow the record without limit. */
export const MAX_WITHDRAW_RECIPIENTS = 500;

export type WithdrawRecipient = {
  txHash: string; // lowercase
  chainId: number;
  recipient: string; // lowercase
  /** unix ms */
  timestamp: number;
};

function isRow(raw: unknown): raw is WithdrawRecipient {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return typeof r.txHash === 'string' && HASH_RE.test(r.txHash)
    && typeof r.chainId === 'number' && Number.isInteger(r.chainId) && r.chainId > 0
    && typeof r.recipient === 'string' && ADDRESS_RE.test(r.recipient)
    && typeof r.timestamp === 'number' && Number.isFinite(r.timestamp);
}

/** A stored list past the bound reads as its newest entries. */
export function parseWithdrawRecipients(raw: unknown): WithdrawRecipient[] {
  return Array.isArray(raw) ? raw.filter(isRow).slice(-MAX_WITHDRAW_RECIPIENTS) : [];
}

/** Latest per (chain, hash) wins; oldest out past the bound. A malformed
 *  entry is not stored. */
export function upsertWithdrawRecipient(list: readonly WithdrawRecipient[], entry: WithdrawRecipient): WithdrawRecipient[] {
  const next = { ...entry, txHash: entry.txHash.toLowerCase(), recipient: entry.recipient.toLowerCase() };
  if (!isRow(next)) return [...list];
  const kept = list.filter((r) => !(r.chainId === next.chainId && r.txHash === next.txHash));
  kept.push(next);
  return kept.length > MAX_WITHDRAW_RECIPIENTS ? kept.slice(kept.length - MAX_WITHDRAW_RECIPIENTS) : kept;
}

export function findWithdrawRecipientIn(list: readonly WithdrawRecipient[], txHash: string | null | undefined, chainId?: number): string | null {
  if (!txHash) return null;
  const needle = txHash.toLowerCase();
  return list.find((r) => r.txHash === needle && (chainId === undefined || r.chainId === chainId))?.recipient ?? null;
}
