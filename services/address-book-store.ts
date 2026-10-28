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
import { parseContacts, type Contact } from '@/services/address-book-core';

export function contactsStorageKey(owner: string): string {
  const tag = bytesToHex(sha256(utf8ToBytes(`ppv2-contacts:${owner.trim().toLowerCase()}`))).slice(0, 24);
  return envScopedStorageKey(`ppv2_contacts_v1_${tag}`);
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

/** Stable per (owner, version), so useSyncExternalStore does not loop. */
export function readContacts(owner: string | null | undefined): Contact[] {
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
  for (const l of listeners) {
    try { l(); } catch { /* a listener must not break the write */ }
  }
  return ok;
}
