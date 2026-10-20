// Storage half of services/swap-records-core.ts. Same shape as
// own-actions-store: web localStorage, native SecureStore, env-scoped key.
// Read synchronously by the activity assembly; written only by the send flows
// (services/swap-bookkeeping.ts) from values already in memory.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { envScopedStorageKey } from '@/config/app-environment';
import {
  parseSwapRecords,
  upsertSwapRecord,
  withDeliveryOutcome,
  type DeliveryOutcome,
  type SwapRecord,
} from '@/services/swap-records-core';

export type { DeliveryOutcome, SwapRecord };

const STORAGE_KEY = envScopedStorageKey('ppv2_swap_records_v1');

// Bumped on every write, so the activity assembly re-reads when a send flow
// records a swap or learns how its delivery ended.
let revision = 0;
const listeners = new Set<() => void>();

export function getSwapRecordsRevision(): number {
  return revision;
}

export function subscribeSwapRecords(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function bump(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

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

function storageSetItem(key: string, value: string): void {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, value);
    } else {
      SecureStore.setItem(key, value);
    }
  } catch (err) {
    console.warn('[swap-records-store] write failed', err);
  }
}

export function readAllSwapRecords(): SwapRecord[] {
  try {
    const raw = storageGetItem(STORAGE_KEY);
    return raw ? parseSwapRecords(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function recordSwap(record: SwapRecord): void {
  storageSetItem(STORAGE_KEY, JSON.stringify(upsertSwapRecord(readAllSwapRecords(), record)));
  bump();
}

export function recordSwapDelivery(update: { sourceChainId: number; txHash: string; outcome: DeliveryOutcome; destinationTxHash?: string | null }): void {
  storageSetItem(STORAGE_KEY, JSON.stringify(withDeliveryOutcome(readAllSwapRecords(), update)));
  bump();
}
