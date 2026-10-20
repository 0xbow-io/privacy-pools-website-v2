// Pure mapping from a transfer's recipient outputs (prepareTransfer's
// executeOptions, or a relayed transfer's plan) to the sender's
// recipient receipts. A transact emits ONE recipient note PER contributing
// lineage (SDK getTransactOutputNotes), so a two-lineage selection produces
// two recipient notes whose values sum to the transfer amount. Everything
// downstream — the out-of-band import payload, the audit disclosures — must
// carry EVERY note with its own SDK value; collapsing to the first note with
// the full amount produces a receipt whose preimage cannot recompute its
// commitment and silently drops the rest of the money.
//
// Kept free of SDK/network imports so the two-recipient-output boundary case
// is unit-testable under the bun runner.

import type { Address, Hash, Hex } from '@/services/sdk-types';

export type RecipientReceipt = {
  commitment: Hash;
  label: Hash;
  noteAddressHash: Hash;
  /** This note's own value (smallest units, hex) — NOT the transfer total. */
  value: Hex;
  tokenId: Address;
  ownerAddress: Address;
  /** Resolved note secret (enriched field or the recipient noteSecretsMap);
   *  null when the SDK returned neither (discoverable transfers may omit it). */
  noteSecret: Hex | null;
};

type PendingNoteLike = {
  commitment: Hash;
  label: Hash;
  noteAddressHash: Hash;
  value?: Hex;
  tokenId?: Address;
  ownerAddress?: Address;
  noteSecret?: Hex;
};

type RecipientLike = {
  publicViewingKey?: unknown;
  noteSecretsMap?: Map<Hash, Hex> | null;
};

const isZeroHex = (v: string | undefined | null): boolean => !v || /^0x0*$/i.test(v);

/**
 * Build one receipt per SDK recipient pending note, resolving each note's
 * secret from the enriched field first, then the recipient's noteSecretsMap
 * (keyed by noteAddressHash). `fallback` fills fields the SDK omits on some
 * shapes (owner/token) — never the value: a receipt without its own SDK value
 * is unusable, so such a note keeps `value` absent-safe as '0x0' only if the
 * SDK truly sent none (callers treat that as an error for out-of-band).
 */
export function buildRecipientReceipts(
  recipientPendingNotes: readonly PendingNoteLike[],
  recipient: RecipientLike,
  fallback: { recipientAddress: Address; tokenId: Address },
): { receipts: RecipientReceipt[]; discoverable: boolean } {
  // ResolvedTransferRecipient is discriminated by field presence (no `kind`
  // tag): publicViewingKey present → discoverable; noteSecretsMap present
  // without publicViewingKey → outOfBand; neither → blind. Discoverable is
  // the only path where the recipient gets an on-chain encrypted Note event.
  const discoverable = 'publicViewingKey' in recipient && recipient.publicViewingKey != null;

  const receipts = recipientPendingNotes.map((note) => {
    const enriched = note.noteSecret;
    const mapSecret = recipient.noteSecretsMap?.get(note.noteAddressHash);
    const noteSecret: Hex | null =
      (enriched && !isZeroHex(enriched) ? enriched : null)
      ?? (mapSecret && !isZeroHex(mapSecret) ? mapSecret : null)
      ?? null;
    return {
      commitment: note.commitment,
      label: note.label,
      noteAddressHash: note.noteAddressHash,
      value: (note.value ?? '0x0') as Hex,
      tokenId: note.tokenId ?? fallback.tokenId,
      // The SDK stamps recipient pending notes with EMPTY_ADDRESS (the sender
      // doesn't know the recipient's note-address preimage owner); treat the
      // zero address as missing so disclosures carry the real recipient.
      ownerAddress: note.ownerAddress && !isZeroHex(note.ownerAddress)
        ? note.ownerAddress
        : fallback.recipientAddress,
      noteSecret,
    };
  });

  return { receipts, discoverable };
}

/** Sum of the receipts' values — must equal the transfer amount; a caller can
 *  use the mismatch as a hard error before shipping a wrong receipt. */
export function receiptsTotal(receipts: readonly RecipientReceipt[]): bigint {
  return receipts.reduce((sum, r) => sum + BigInt(r.value), 0n);
}

/** A planned recipient output, before the proof (services/relayed-transfer.ts). */
type PlannedOutputLike = {
  commitment: Hash;
  label: Hash;
  noteAddressHash: Hash;
  value: Hex;
  noteSecret: Hex | null;
};

/**
 * One receipt per planned recipient output of a relayed transfer. The plan
 * carries each note's own value and the secret this client made for it, and
 * the relay check holds the proof to these commitments before the POST.
 */
export function plannedRecipientReceipts(
  outputs: readonly PlannedOutputLike[],
  recipient: { recipientAddress: Address; tokenId: Address },
): RecipientReceipt[] {
  return outputs.map((o) => ({
    commitment: o.commitment,
    label: o.label,
    noteAddressHash: o.noteAddressHash,
    value: o.value,
    tokenId: recipient.tokenId,
    ownerAddress: recipient.recipientAddress,
    noteSecret: o.noteSecret,
  }));
}

/** A recipient note's full preimage, kept for the sender's audit receipts. */
export type RecipientDisclosure = {
  ownerAddress: Address;
  noteSecret: Hex;
  tokenId: Address;
  value: Hex;
  label: Hash;
  commitment: Hash;
};

/** The disclosures for every receipt whose secret is known. */
export function recipientDisclosuresOf(receipts: readonly RecipientReceipt[]): RecipientDisclosure[] {
  return receipts
    .filter((r): r is RecipientReceipt & { noteSecret: Hex } => r.noteSecret != null)
    .map((r) => ({
      ownerAddress: r.ownerAddress,
      noteSecret: r.noteSecret,
      tokenId: r.tokenId,
      value: r.value,
      label: r.label,
      commitment: r.commitment,
    }));
}
