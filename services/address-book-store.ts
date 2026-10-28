// Storage half of services/address-book-core.ts. Same shape as the other
// device records (web localStorage, native SecureStore, env-scoped key), one
// list per OWNER: keyed on the session identity the account export is filed
// under (useSdkContext().sessionAddress), never the wagmi address.
//
// The key carries a hash of the owner, not the owner: anyone reading the
// browser profile should not learn which address used the app from key names.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { envScopedStorageKey } from '@/config/app-environment';
import { parseContacts, parseRecipientRecords, upsertRecipientRecord, type Contact, type RecipientRecord } from '@/services/address-book-core';

function ownerTag(owner: string): string {
  return bytesToHex(sha256(utf8ToBytes(`ppv2-contacts:${owner.trim().toLowerCase()}`))).slice(0, 24);
}

export function contactsStorageKey(owner: string): string {
  return envScopedStorageKey(`ppv2_contacts_v1_${ownerTag(owner)}`);
}

/**
 * Recipient history, per owner. A payment made with no session identity (a
 * Stellar or Sui wallet on its own) goes to the device bucket, which every
 * owner on this device also reads.
 */
export function recipientsStorageKey(owner: string | null): string {
  return envScopedStorageKey(owner ? `ppv2_recipients_v1_${ownerTag(owner)}` : 'ppv2_recipients_v1_device');
}

function storageGetItem(key: string): string | null {
  try {
    if (Platform.OS === 'web') return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    return SecureStore.getItem(key);
  } catch {
    return null;
  }
}

function storageSetItem(key: string, value: string): boolean {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return false;
      localStorage.setItem(key, value);
    } else {
      SecureStore.setItem(key, value);
    }
    return true;
  } catch (err) {
    console.warn('[address-book-store] write failed', err);
    return false;
  }
}

const listeners = new Set<() => void>();
let version = 0;
const cache = new Map<string, { version: number; list: Contact[] }>();

export function subscribeContacts(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getContactsVersion(): number {
  return version;
}

/**
 * Stable per (owner, version), so useSyncExternalStore does not loop.
 * `atVersion` is the version the caller rendered with: passing it makes the
 * store version a real input of the call, which the React Compiler then keeps
 * as a memo dependency (a `void version` line was compiled away and the list
 * never refreshed after a save, seen on the production build).
 */
export function readContacts(owner: string | null | undefined, atVersion?: number): Contact[] {
  void atVersion;
  if (!owner) return EMPTY;
  const key = contactsStorageKey(owner);
  const hit = cache.get(key);
  if (hit && hit.version === version) return hit.list;
  let list: Contact[] = [];
  try {
    const raw = storageGetItem(key);
    list = raw ? parseContacts(JSON.parse(raw)) : [];
  } catch {
    list = [];
  }
  cache.set(key, { version, list });
  return list;
}
const EMPTY: Contact[] = [];

/** Replace the owner's list. Returns false when storage refused the write. */
export function writeContacts(owner: string, list: readonly Contact[]): boolean {
  const ok = storageSetItem(contactsStorageKey(owner), JSON.stringify(list));
  version++;
  cache.clear();
  recipientsCache.clear();
  for (const l of listeners) {
    try { l(); } catch { /* a listener must not break the write */ }
  }
  return ok;
}

const recipientsCache = new Map<string, { version: number; list: RecipientRecord[] }>();

/** Oldest first. `null` reads the device bucket. */
export function readRecipientRecords(owner: string | null, atVersion?: number): RecipientRecord[] {
  void atVersion;
  const key = recipientsStorageKey(owner);
  const hit = recipientsCache.get(key);
  if (hit && hit.version === version) return hit.list;
  let list: RecipientRecord[] = [];
  try {
    const raw = storageGetItem(key);
    list = raw ? parseRecipientRecords(JSON.parse(raw)) : [];
  } catch {
    list = [];
  }
  recipientsCache.set(key, { version, list });
  return list;
}

export function writeRecipientRecords(owner: string | null, list: readonly RecipientRecord[]): boolean {
  const ok = storageSetItem(recipientsStorageKey(owner), JSON.stringify(list));
  version++;
  cache.clear();
  recipientsCache.clear();
  for (const l of listeners) {
    try { l(); } catch { /* a listener must not break the write */ }
  }
  return ok;
}

/**
 * A confirmed withdrawal or send paid `address` on `chainId`. Called by every
 * payout path at confirmation; never throws (bookkeeping must not fail a
 * payment that already landed).
 */
export function recordRecipientUse(owner: string | null | undefined, address: string | null | undefined, chainId: number, now = Date.now()): void {
  try {
    if (!address) return;
    const who = owner || null;
    writeRecipientRecords(who, upsertRecipientRecord(readRecipientRecords(who), address, chainId, now));
  } catch {
    /* non-fatal */
  }
}

// The session identity payments are recorded under. Set by the payment
// providers from the same sessionAddress the contacts hook reads, so a record
// written at confirmation lands where the autocomplete looks. Module state on
// purpose: bookkeeping helpers run inside long-lived callbacks.
let activeOwner: string | null = null;

export function setActiveRecipientOwner(owner: string | null | undefined): void {
  activeOwner = owner || null;
}

export function recordRecipientUseForActiveOwner(address: string | null | undefined, chainId: number): void {
  recordRecipientUse(activeOwner, address, chainId);
}

/** Drop-in for recordWithdrawRecipient that also writes the recipient history. */
export function recordWithdrawRecipientAndHistory(entry: { recipient: string; chainId: number } & Record<string, unknown>, record: (e: never) => void): void {
  try { record(entry as never); } catch { /* the legacy store must not stop the history */ }
  recordRecipientUseForActiveOwner(entry.recipient, entry.chainId);
}
