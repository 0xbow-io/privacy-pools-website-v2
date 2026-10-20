// Local record of payment requests paid FROM THIS WALLET via "Pay via Wallet".
//
// Why this has to exist, and why it can't be derived:
//
// "Pay via Wallet" is `prepareDepositFor` — an ordinary `Entrypoint.deposit`
// submitted by the payer. On-chain, the Deposit event's depositor IS the payer;
// the person actually being paid exists only inside
// `noteAddressHash = Poseidon(recipientAddress, noteSecret)`, which is
// unlinkable by design. So the ASP indexes it, correctly, as a deposit by the
// payer — it has no way to know a third party was credited, and no amount of
// backend work can give it one without breaking the privacy property.
//
// That collides with the balance fallback in components/pools-provider.tsx,
// which folds ASP deposit events for the connected address into the user's
// balance to cover "my deposit whose note hasn't been discovered yet". It
// dedupes against LOCAL note tx hashes — and `prepareDepositFor` deliberately
// persists no local note (`isOwned: false`), because the depositor is not the
// note owner. Nothing dedupes, so a payment you made to someone else was
// counted into YOUR pending balance and deposit count: the app told you that
// you still had money you had just given away.
//
// Stamping the tx hash here at pay time is the same trick, for the same reason,
// as services/sent-transfers-store.ts: the ASP cannot tell us who a transaction
// was FOR, so the device that made it records that fact locally.
//
// Per-device, like every other local signal here. The consequence of a missing
// stamp (paid on another device, or storage cleared) is the old cosmetic
// over-count, never a wrong on-chain outcome.
import { Platform } from 'react-native';
import { envScopedStorageKey } from '@/config/app-environment';
import * as SecureStore from 'expo-secure-store';
import {
  findPaidRequestIn,
  parsePaidRequests,
  toPaidRequestTxHashSet,
  upsertPaidRequest,
  type PaidRequest,
} from '@/services/paid-requests-core';

export type { PaidRequest };

// Environment-scoped (config/app-environment.ts): prod and staging deploy on the
// same chain ids, so a chain-keyed record must not cross between worlds.
const STORAGE_KEY = envScopedStorageKey('ppv2_paid_requests_v1');


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
      console.warn('[paid-requests-store] write failed', err);
    }
    return;
  }
  try {
    SecureStore.setItem(key, value);
  } catch (err) {
    console.warn('[paid-requests-store] write failed', err);
  }
}

export function readAllPaidRequests(): PaidRequest[] {
  return parsePaidRequests(storageGetItem(STORAGE_KEY));
}

export function recordPaidRequest(entry: PaidRequest): void {
  const next = upsertPaidRequest(readAllPaidRequests(), entry);
  try {
    storageSetItem(STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('[paid-requests-store] write failed', err);
  }
}

export function findPaidRequest(txHash: string | null | undefined): PaidRequest | null {
  return findPaidRequestIn(readAllPaidRequests(), txHash);
}

/**
 * Tx hashes to EXCLUDE from the connected user's own deposit accounting.
 * Pass the viewer's address so a payment to YOURSELF stays counted as yours.
 */
export function buildPaidRequestTxHashSet(viewerAddress?: string | null): Set<string> {
  return toPaidRequestTxHashSet(readAllPaidRequests(), viewerAddress);
}
