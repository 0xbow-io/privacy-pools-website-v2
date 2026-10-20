// Local record of the recipient note for each outgoing transfer, so the
// sender can later export a per-transaction "partial viewing key" (an
// audit receipt) proving they paid someone — see services/audit-receipt.ts.
//
// Why a separate store: the recipient's note is NOT in the sender's
// NoteManager (it belongs to the recipient). But prepareTransfer hands
// the sender the recipient note's full preimage (commitment, noteSecret,
// value, tokenId, label, ownerAddress) at send time. We stash it here,
// keyed by txHash, the moment the transfer confirms. Per-device only,
// which matches the activity feed (NoteManager state is local anyway).
import { Platform } from 'react-native';
import { envScopedStorageKey } from '@/config/app-environment';
import * as SecureStore from 'expo-secure-store';
import type { SentNoteDisclosure } from '@/services/audit-receipt';
import { mergeSentAudits, readStoredAudits, sentAuditsForRow, type StoredAuditsResult } from '@/services/audit-store-core';

// Environment-scoped (config/app-environment.ts): prod and staging deploy on the
// same chain ids, so a chain-keyed record must not cross between worlds.
const STORAGE_KEY = envScopedStorageKey('ppv2_sent_audit_v1');

// Deliberately NOT swallowing: a throwing accessor is a failed read, and
// `readAllResult` must see it as one. An absent web storage is a store that
// holds nothing and accepts nothing, which reads as empty.
function storageGetItemOrThrow(key: string): string | null {
  if (Platform.OS === 'web') {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  }
  return SecureStore.getItem(key);
}

function storageSetItem(key: string, value: string): void {
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, value);
    } catch {
      // ignore
    }
    return;
  }
  try {
    SecureStore.setItem(key, value);
  } catch {
    // ignore
  }
}

function readAllResult(): StoredAuditsResult {
  return readStoredAudits(() => storageGetItemOrThrow(STORAGE_KEY));
}

function readAll(): SentNoteDisclosure[] {
  return readAllResult().list;
}

/**
 * Record the recipient-note disclosures for one transfer tx. A multi-lineage
 * transfer emits one recipient note PER contributing lineage, so a tx can
 * carry several disclosures — entries are keyed by (txHash, commitment) and
 * this replaces the tx's whole set atomically.
 */
export function recordSentAudits(list: readonly SentNoteDisclosure[]): void {
  if (list.length === 0) return;
  // ABORT ON AN UNREADABLE STORE, rather than treating it as empty.
  //
  // This is a read-modify-WRITE: whatever comes back from the read is written
  // back with the new rows appended. `readAll` used to answer an unreadable
  // store with `[]` - a throwing accessor, unparseable JSON, a value that is
  // not an array - so one bad read turned the next recorded transfer into a
  // silent, total erasure of every disclosure already held.
  //
  // These rows are not diagnostics. For a payment to someone who never
  // registered, the disclosure is the ONLY route back to the money: the row
  // menu rebuilds the recipient's one-time link from it. Losing the set loses
  // real payments, with nothing on screen to say so.
  //
  // Refusing to write is the safe failure. The disclosure for THIS payment is
  // lost, which the caller can see and react to, instead of this payment
  // quietly destroying every earlier one (codex, 2026-09-16).
  const current = readAllResult();
  if (!current.ok) {
    console.warn('[audit-store] refusing to write over an unreadable store; disclosure not recorded');
    return;
  }
  const filtered = mergeSentAudits(current.list, list);
  try {
    storageSetItem(STORAGE_KEY, JSON.stringify(filtered));
  } catch {
    // ignore
  }
}

export function recordSentAudit(d: SentNoteDisclosure): void {
  recordSentAudits([d]);
}

/**
 * Record, then prove it landed. Returns false when the disclosure is NOT
 * durably stored.
 *
 * `recordSentAudits` cannot fail visibly: `storageSetItem` swallows both the
 * web and native error paths, does nothing at all when `localStorage` is
 * absent, and the caller catches again on top. For a transfer that is a
 * reasonable trade - the disclosure powers an audit export the user can live
 * without. For a note whose ONLY route to the recipient is the link rebuilt
 * from this record, a silent failure means the caller tells the sender "you
 * can copy it later" and it is not there. That exact reassurance was written
 * against a write that could not report failure (codex, 2026-09-16).
 *
 * The read-back is the point: it catches a quota rejection, a private-mode
 * localStorage that accepts and discards, and an absent store, none of which
 * throw where the caller can see them.
 */
export function recordSentAuditsVerified(list: readonly SentNoteDisclosure[]): boolean {
  if (list.length === 0) return true;
  recordSentAudits(list);
  const stored = findSentAudits(list[0].txHash);
  return list.every((d) =>
    stored.some(
      (s) =>
        String(s.commitment).toLowerCase() === String(d.commitment).toLowerCase() &&
        String(s.noteSecret) === String(d.noteSecret),
    ),
  );
}

/**
 * Forget every disclosure under one key. Used to retire the provisional
 * record a blind deposit writes before it knows its tx hash, once the same
 * disclosure has been re-stored under the real one - and only then, so a
 * failed re-store leaves the secret recoverable rather than deleted.
 */
export function dropSentAudits(txHash: string): void {
  // Same read-modify-write hazard as recordSentAudits, same rule: never write
  // over a store we could not read. The first version filtered `readAll()`,
  // which answers an unreadable store with `[]`, so a transient read failure
  // right after a successful re-key would have written `[]` back - deleting
  // the row just verified AND every older claim secret (codex second pass,
  // 2026-09-16). Refusing leaves a harmless duplicate row; writing loses money.
  const current = readAllResult();
  if (!current.ok) {
    console.warn('[audit-store] refusing to drop over an unreadable store; provisional row kept');
    return;
  }
  const needle = txHash.toLowerCase();
  const remaining = current.list.filter((x) => x.txHash.toLowerCase() !== needle);
  try {
    storageSetItem(STORAGE_KEY, JSON.stringify(remaining));
  } catch {
    // A failed cleanup leaves a harmless duplicate, never a lost secret.
  }
}

/** Every disclosure recorded for a tx (one per recipient note). */
export function findSentAudits(txHash: string | null | undefined): SentNoteDisclosure[] {
  if (!txHash) return [];
  const needle = txHash.toLowerCase();
  return readAll().filter((x) => x.txHash.toLowerCase() === needle);
}

export function findSentAudit(txHash: string | null | undefined): SentNoteDisclosure | null {
  return findSentAudits(txHash)[0] ?? null;
}

/**
 * Disclosures for a history row, falling back to the provisional record an
 * unknown-outcome transfer left under one of the row's own notes (DEV-413).
 */
export function findSentAuditsForRow(
  txHash: string | null | undefined,
  rowNoteCommitments: readonly string[],
): SentNoteDisclosure[] {
  return sentAuditsForRow(txHash, rowNoteCommitments, findSentAudits);
}
