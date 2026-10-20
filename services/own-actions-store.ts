// Storage half of services/own-actions-core.ts. Same shape as
// sent-transfers-store: web localStorage, native SecureStore, env-scoped key.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { envScopedStorageKey } from '@/config/app-environment';
import {
  findOwnActionIn,
  isOwnDepositOutput,
  parseOwnActions,
  toOwnActionMap,
  upsertOwnAction,
  type OwnAction,
  type OwnActionKind,
} from '@/services/own-actions-core';

export type { OwnAction, OwnActionKind };
export { isOwnDepositOutput };

const STORAGE_KEY = envScopedStorageKey('ppv2_own_actions_v1');

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
    console.warn('[own-actions-store] write failed', err);
  }
}

export function readAllOwnActions(): OwnAction[] {
  try {
    const raw = storageGetItem(STORAGE_KEY);
    return raw ? parseOwnActions(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

/** Record what this device just did, keyed by the transaction hash. */
export function recordOwnAction(entry: OwnAction): void {
  storageSetItem(STORAGE_KEY, JSON.stringify(upsertOwnAction(readAllOwnActions(), entry)));
}

export function findOwnAction(txHash: string | null | undefined, chainId?: number): OwnAction | null {
  return findOwnActionIn(readAllOwnActions(), txHash, chainId);
}

export function buildOwnActionMap(chainId: number): Map<string, OwnAction> {
  return toOwnActionMap(readAllOwnActions(), chainId);
}
