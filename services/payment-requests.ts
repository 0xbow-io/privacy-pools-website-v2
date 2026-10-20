import { Platform } from 'react-native';
import { envScopedStorageKey } from '@/config/app-environment';
import * as SecureStore from 'expo-secure-store';

import { NATIVE_ASSET_ADDRESS } from '@/config/tokens';
import type { PaymentRequestPayloadV1 } from '@/services/payment-request-codec';
import type { Hex } from '@/services/sdk-types';

export * from '@/services/payment-request-codec';

export type StoredPaymentRequest = PaymentRequestPayloadV1 & {
  noteSecret: Hex;
};

// Environment-scoped (config/app-environment.ts): prod and staging deploy on the
// same chain ids, so a chain-keyed record must not cross between worlds.
const STORAGE_KEY = envScopedStorageKey('ppv2_payment_requests_v1');

function storageGetItem(key: string): string | null {
  if (Platform.OS === 'web') {
    try {
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

function readAllRequests(): StoredPaymentRequest[] {
  try {
    const raw = storageGetItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed as StoredPaymentRequest[] : [];
  } catch {
    return [];
  }
}

function writeAllRequests(requests: StoredPaymentRequest[]): void {
  storageSetItem(STORAGE_KEY, JSON.stringify(requests));
}

// NO WRITER EXISTS ON PURPOSE. The v1 flow (recipient-generated noteSecret,
// persisted in PLAINTEXT here, receipt hand-off) is a fossil: every current
// create is registered v2 (stateless) or SDK-native v3 (no persisted keys).
// This store is READ-ONLY legacy compatibility for requests old builds wrote
// on this browser — and each record is DELETED the moment its payment is
// claimed (removeStoredPaymentRequest below), so lingering fund-controlling
// secrets clean themselves out of localStorage.

/** All legacy V1 requests stored on this device (newest saved first). */
export function listStoredPaymentRequests(): StoredPaymentRequest[] {
  return readAllRequests();
}

/** Purge a legacy record once its payment is claimed — the noteSecret has
 *  served its purpose and must not linger in plaintext storage. */
export function removeStoredPaymentRequest(requestId: string): void {
  const target = requestId.toLowerCase();
  const remaining = readAllRequests().filter((entry) => entry.requestId.toLowerCase() !== target);
  writeAllRequests(remaining);
}

export function findStoredPaymentRequest(match: { requestId?: string; noteAddressHash?: string }): StoredPaymentRequest | null {
  const targetRequestId = match.requestId?.toLowerCase();
  const targetNoteAddressHash = match.noteAddressHash?.toLowerCase();
  return (
    readAllRequests().find((entry) =>
      (targetRequestId && entry.requestId.toLowerCase() === targetRequestId)
      || (targetNoteAddressHash && entry.noteAddressHash.toLowerCase() === targetNoteAddressHash),
    ) ?? null
  );
}

export const REQUESTABLE_TOKENS = [
  { symbol: 'ETH', address: NATIVE_ASSET_ADDRESS as Hex, decimals: 18, isNative: true },
  { symbol: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as Hex, decimals: 6, isNative: false },
  { symbol: 'USDT', address: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0' as Hex, decimals: 6, isNative: false },
] as const;
