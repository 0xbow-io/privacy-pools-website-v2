// Storage half of services/withdraw-recipients-core.ts. Same shape as
// own-actions-store: web localStorage, native SecureStore, env-scoped key.
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { envScopedStorageKey } from '@/config/app-environment';
import {
  findWithdrawRecipientIn,
  parseWithdrawRecipients,
  upsertWithdrawRecipient,
  type WithdrawRecipient,
} from '@/services/withdraw-recipients-core';

export type { WithdrawRecipient };

const STORAGE_KEY = envScopedStorageKey('ppv2_withdraw_recipients_v1');

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
    console.warn('[withdraw-recipients-store] write failed', err);
  }
}

export function readAllWithdrawRecipients(): WithdrawRecipient[] {
  try {
    const raw = storageGetItem(STORAGE_KEY);
    return raw ? parseWithdrawRecipients(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function recordWithdrawRecipient(entry: WithdrawRecipient): void {
  storageSetItem(STORAGE_KEY, JSON.stringify(upsertWithdrawRecipient(readAllWithdrawRecipients(), entry)));
}

export function findWithdrawRecipient(txHash: string | null | undefined, chainId?: number): string | null {
  return findWithdrawRecipientIn(readAllWithdrawRecipients(), txHash, chainId);
}
