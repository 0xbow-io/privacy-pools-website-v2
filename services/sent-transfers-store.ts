// Local record of transfers initiated on this device.
//
// The activity feed comes from the ASP, which can't tell us whether the
// connected user was the sender or the recipient of a Transacted event —
// both sides only own a note that was created in the same tx. The label
// signal is missing on the ASP side and the SDK's `spentAtBlock` is the
// block number rather than a timestamp, so the on-chain heuristics in
// transfer-direction.ts fall through to the "user owns a non-SPENT
// output → recipient" branch and the sender's own transfer is mis-
// classified as a Transfer In on their change.
//
// Stamping the txHash here when the user sends gives us a reliable
// "this tx came from me" signal that doesn't depend on SDK internals
// or the ASP's label coverage. Per-device only — fine, because the
// activity feed is per-device anyway (NoteManager state is local).
import { Platform } from 'react-native';
import { envScopedStorageKey } from '@/config/app-environment';
import * as SecureStore from 'expo-secure-store';

// Environment-scoped (config/app-environment.ts): prod and staging deploy on the
// same chain ids, so a chain-keyed record must not cross between worlds.
const STORAGE_KEY = envScopedStorageKey('ppv2_sent_transfers_v1');

export interface SentTransfer {
  txHash: string;        // lowercase
  recipient: string;     // 0x-prefixed, original case (so it can be displayed)
  rawAmount: string;     // hex bigint, smallest-units (matches Note.value)
  tokenAddress: string;  // lowercase
  chainId: number;
  timestamp: number;     // unix ms
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
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, value);
    } catch (err) {
      console.warn('[sent-transfers-store] write failed', err);
    }
    return;
  }
  try {
    SecureStore.setItem(key, value);
  } catch (err) {
    console.warn('[sent-transfers-store] write failed', err);
  }
}

export function readAllSentTransfers(): SentTransfer[] {
  try {
    const raw = storageGetItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SentTransfer[]) : [];
  } catch {
    return [];
  }
}

export function recordSentTransfer(tx: SentTransfer): void {
  const all = readAllSentTransfers();
  const normalized: SentTransfer = {
    ...tx,
    txHash: tx.txHash.toLowerCase(),
    tokenAddress: tx.tokenAddress.toLowerCase(),
  };
  const filtered = all.filter((t) => t.txHash !== normalized.txHash);
  filtered.push(normalized);
  try {
    storageSetItem(STORAGE_KEY, JSON.stringify(filtered));
  } catch (err) {
    console.warn('[sent-transfers-store] write failed', err);
  }
}

export function findSentTransfer(txHash: string | null | undefined): SentTransfer | null {
  if (!txHash) return null;
  const needle = txHash.toLowerCase();
  return readAllSentTransfers().find((t) => t.txHash === needle) ?? null;
}

export function buildSentTxHashSet(): Set<string> {
  const all = readAllSentTransfers();
  return new Set(all.map((t) => t.txHash));
}
