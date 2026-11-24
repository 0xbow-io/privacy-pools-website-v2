/**
 * Per-transaction disclosures (partial viewing keys) for Stellar sends, in the
 * same `SentNoteDisclosure` shape the EVM sent-audit store keeps
 * (services/audit-store.ts), so the accounting export and the row menu treat
 * both chains alike.
 *
 * PURE: no storage, no request. The secrets come from what this device
 * already holds: the SDK's own result of a send to a registered account, or the
 * saved one-time claim of a send to an account with no viewing key yet
 * (stellar-sent-claims.ts).
 */
import type { SentNoteDisclosure } from '@/services/audit-receipt';
import type { Address, Hash, Hex, Secret } from '@/services/sdk-types';
import type { StellarSentClaim } from '@/services/stellar/stellar-sent-claims';
import { STELLAR_TESTNET_ID } from '@/config/stellar-deployment';

/** A recipient note as the SDK returns it from a send (or as a claim keeps it). */
export type StellarRecipientNote = {
  commitment: unknown;
  ownerAddress?: unknown;
  noteSecret?: unknown;
  value: unknown;
  tokenId: unknown;
  label: unknown;
};

function toBig(value: unknown): bigint | null {
  try { return BigInt(String(value)); } catch { return null; }
}

function toHexValue(value: bigint): Hex {
  return `0x${value.toString(16)}` as Hex;
}

/**
 * One disclosure per recipient note of a Stellar send, or none at all.
 *
 * All or nothing: a partial set would undercount what was paid while still
 * reading as proven, so the notes must carry their secrets, belong to the
 * recipient and add up to exactly the amount sent. Anything else leaves the
 * send CSV-only, as an EVM send with no disclosure is.
 */
export function stellarSentDisclosures(input: {
  chainId: number;
  txHash: string;
  recipient: string;
  /** What the recipient got, base units. */
  amount: bigint;
  notes: readonly StellarRecipientNote[] | null | undefined;
}): SentNoteDisclosure[] {
  const { chainId, txHash, recipient, amount, notes } = input;
  if (!txHash || !recipient || !notes || notes.length === 0) return [];
  const out: SentNoteDisclosure[] = [];
  let total = 0n;
  for (const n of notes) {
    const value = toBig(n.value);
    const secret = n.noteSecret == null ? '' : String(n.noteSecret);
    const owner = n.ownerAddress == null || n.ownerAddress === '' ? recipient : String(n.ownerAddress);
    if (value === null || !secret || !n.commitment || !n.tokenId || !n.label) return [];
    if (owner.toUpperCase() !== recipient.toUpperCase()) return [];
    total += value;
    out.push({
      chainId,
      txHash: txHash as Hash,
      commitment: String(n.commitment) as Hash,
      ownerAddress: owner as Address,
      noteSecret: secret as Secret,
      tokenId: String(n.tokenId) as Address,
      value: toHexValue(value),
      label: String(n.label) as Hash,
    });
  }
  return total === amount ? out : [];
}

/**
 * A Stellar tx hash in both spellings it reaches this app in (an SDK receipt
 * prefixes 0x, an indexed event row may not), for lookups in stores keyed by
 * the exact string. The given spelling comes first.
 */
export function stellarTxHashSpellings(txHash: string): string[] {
  const bare = String(txHash ?? '').replace(/^0x/i, '');
  if (!bare) return [];
  return [...new Set([txHash, `0x${bare}`, bare])];
}

/** The first non-empty lookup over a Stellar tx hash's spellings. */
export function findBySpelling<T>(txHash: string, find: (h: string) => T | null | undefined, isEmpty: (v: T) => boolean = () => false): T | null {
  for (const h of stellarTxHashSpellings(txHash)) {
    const hit = find(h);
    if (hit != null && !isEmpty(hit)) return hit;
  }
  return null;
}

/**
 * The chains whose history the accounting export still waits for, with
 * Stellar added while its account is unlocked but has no COMPLETE read of the
 * pool's history: its sends, withdrawals and exits are rebuilt from that read,
 * and received transfers only from a complete one, so exporting before it (or
 * after a refresh that failed and left the index incomplete) would drop them,
 * the way an EVM chain whose history has not loaded would.
 */
export function withStellarHistoryPending(
  pending: readonly number[],
  stellar: { selected: boolean; unlocked: boolean; noteOrigins: { complete: boolean } | null | undefined },
): number[] {
  const waiting = stellar.selected && stellar.unlocked && stellar.noteOrigins?.complete !== true;
  if (!waiting || pending.includes(STELLAR_TESTNET_ID)) return [...pending];
  return [...pending, STELLAR_TESTNET_ID];
}

/**
 * The disclosures of a confirmed one-time send (or blind deposit for someone),
 * from its saved claim. A claim keeps every note the transaction made for the
 * recipient (saved before it was sent), so its notes are the whole set; the
 * claim's `amount` is what was asked for, which a deposit's fee can make
 * differ from what the notes hold.
 */
export function stellarClaimDisclosures(chainId: number, claim: StellarSentClaim | null | undefined): SentNoteDisclosure[] {
  if (!claim?.txHash || claim.notes.length === 0) return [];
  let amount = 0n;
  for (const n of claim.notes) {
    const value = toBig(n.value);
    if (value === null) return [];
    amount += value;
  }
  return stellarSentDisclosures({ chainId, txHash: claim.txHash, recipient: claim.recipient, amount, notes: claim.notes });
}
