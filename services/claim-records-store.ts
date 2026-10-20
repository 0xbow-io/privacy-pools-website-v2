// Storage half of services/claim-records-core.ts. Same shape as
// own-actions-store: web localStorage, native SecureStore, env-scoped key.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { envScopedStorageKey } from '@/config/app-environment';
import { MAX_CLAIM_RECORDS, parseClaimRecords, toClaimedInputMap, upsertClaimRecords, type ClaimRecord } from '@/services/claim-records-core';
import { readWebClaimRecords, writeWebClaimRecords } from '@/services/claim-records-web';

const STORAGE_KEY = envScopedStorageKey('ppv2_claim_records_v1');

function storageGetItem(key: string): string | null {
  try {
    if (Platform.OS === 'web') return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    return SecureStore.getItem(key);
  } catch {
    return null;
  }
}

function storageSetItem(key: string, value: string): void {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, value);
    } else {
      SecureStore.setItem(key, value);
    }
  } catch (err) {
    console.warn('[claim-records-store] write failed', err);
  }
}

export function readAllClaimRecords(): ClaimRecord[] {
  try {
    if (Platform.OS === 'web') {
      return typeof localStorage === 'undefined' ? [] : readWebClaimRecords(localStorage, STORAGE_KEY).slice(-MAX_CLAIM_RECORDS);
    }
    const raw = storageGetItem(STORAGE_KEY);
    return raw ? parseClaimRecords(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** Record received notes only after our claim's nullifiers were confirmed spent. */
export function recordClaimInputs(chainId: number, commitments: readonly string[], withRegistration: boolean): void {
  if (commitments.length === 0) return;
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage !== 'undefined') {
        writeWebClaimRecords(localStorage, STORAGE_KEY, upsertClaimRecords([], { chainId, commitments, withRegistration, now: Date.now() }));
      }
    } catch (err) {
      console.warn('[claim-records-store] write failed', err);
    }
    return;
  }
  const next = upsertClaimRecords(readAllClaimRecords(), { chainId, commitments, withRegistration, now: Date.now() });
  storageSetItem(STORAGE_KEY, JSON.stringify(next.slice(-NATIVE_MAX_RECORDS)));
}

// Native SecureStore keeps values small (about 2 KB), so a phone keeps only the
// most recent claims. An older claim is long confirmed, and its anchor stamp
// already names it.
const NATIVE_MAX_RECORDS = 12;

export function readClaimedInputMap(): Map<string, { withRegistration: boolean }> {
  return toClaimedInputMap(readAllClaimRecords());
}
