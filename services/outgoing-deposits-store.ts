// Storage half of services/outgoing-deposits-core.ts: deposits this wallet made
// for another address. Same storage shape and reasons as paid-requests-store.ts
// (web: localStorage; native: SecureStore), but tx-hash only.
import { Platform } from 'react-native';
import { envScopedStorageKey } from '@/config/app-environment';
import * as SecureStore from 'expo-secure-store';
import {
  parseOutgoingDeposits,
  toOutgoingDepositTxHashSet,
  upsertOutgoingDeposit,
  type OutgoingDeposit,
} from '@/services/outgoing-deposits-core';

export type { OutgoingDeposit };

// Environment-scoped (config/app-environment.ts): prod and staging deploy on the
// same chain ids, so a chain-keyed record must not cross between worlds.
const STORAGE_KEY = envScopedStorageKey('ppv2_outgoing_deposits_v1');

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
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, value);
    } catch (err) {
      console.warn('[outgoing-deposits-store] write failed', err);
    }
    return;
  }
  try {
    SecureStore.setItem(key, value);
  } catch (err) {
    console.warn('[outgoing-deposits-store] write failed', err);
  }
}

export function readAllOutgoingDeposits(): OutgoingDeposit[] {
  return parseOutgoingDeposits(storageGetItem(STORAGE_KEY));
}

// Change signal for readers that memoise the stamp set. A stamp written by the
// deposit flow rides on the note change that follows it; one written from the
// row menu (a claim link recovered on a fresh browser re-stamps its row) has
// no such change, and the row kept its ordinary Deposit presentation and
// spending actions until something else re-rendered the memo (codex round 4).
// Consumers subscribe through useSyncExternalStore.
let outgoingDepositsVersion = 0;
const outgoingDepositsListeners = new Set<() => void>();

export function subscribeOutgoingDeposits(listener: () => void): () => void {
  outgoingDepositsListeners.add(listener);
  return () => {
    outgoingDepositsListeners.delete(listener);
  };
}

export function getOutgoingDepositsVersion(): number {
  return outgoingDepositsVersion;
}

function notifyOutgoingDepositsChanged(): void {
  outgoingDepositsVersion += 1;
  for (const listener of outgoingDepositsListeners) listener();
}

/** Record a CONFIRMED deposit made for another address. */
export function recordOutgoingDeposit(entry: OutgoingDeposit): void {
  const next = upsertOutgoingDeposit(readAllOutgoingDeposits(), entry);
  try {
    storageSetItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('[outgoing-deposits-store] write failed', err);
  }
  notifyOutgoingDepositsChanged();
}

/** Tx hashes this payer stamped as deposits for someone else (lowercase). */
export function buildOutgoingDepositTxHashSet(payer: string | null | undefined, chainId?: number): Set<string> {
  return toOutgoingDepositTxHashSet(readAllOutgoingDeposits(), payer, chainId);
}
