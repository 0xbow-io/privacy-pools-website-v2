// Read-only access to the persisted payment-request stores. Pure (no
// react-native import) and — critically — NO-WRITE: display surfaces such as
// the always-mounted Payment Requests card must never trigger a storage
// migration as a side effect of rendering. Legacy-shaped records (pre-v2.0
// SDK) are upgraded IN MEMORY only; the persisted blob is left byte-for-byte
// untouched. In particular, a pre-v2 record's stored `paymentPrivKey` (a
// RANDOM ephemeral key the current SDK cannot re-derive) stays in storage.

import type { PaymentRequestServiceState } from '@privacy-pools-v2/sdk';

import { PaymentRequestServiceStateSchema } from '@/services/payment-request-state-schema';
import { upgradeLegacyPaymentRequestState } from '@/services/payment-request-state-migration';

/** Minimal read side of services/sdk-storage's IStorageService. */
export type ReadOnlyStorage = {
  get<T>(key: string): Promise<T | null>;
};

// Base of the SDK's payment-request storage key (version + STORAGE_KEYS
// entry) — kept in sync with the SDK's PaymentRequestStorageAdapter, which
// appends `:<chainId>:<owner-lowercase>`.
export const PAYMENT_REQUEST_KEY_BASE = 'v1:payment-request-state';

export function paymentRequestStateKey(chainId: number, ownerAddress: string): string {
  return `${PAYMENT_REQUEST_KEY_BASE}:${chainId}:${ownerAddress.toLowerCase()}`;
}

/**
 * Read one chain's persisted payment-request state without writing anything
 * back. Legacy shapes are normalized in memory; validation uses ppv2's
 * schema mirror, which (unlike the SDK's runtime schema) RETAINS a stored
 * `paymentPrivKey` so legacy random-key records stay usable and exportable.
 * Returns null when nothing is stored or the blob fails validation.
 */
export async function readPaymentRequestStateNoWrite(
  storage: ReadOnlyStorage,
  chainId: number,
  ownerAddress: string,
): Promise<PaymentRequestServiceState | null> {
  return (await readPaymentRequestStateNoWriteDetailed(storage, chainId, ownerAddress)).state;
}

/**
 * Like {@link readPaymentRequestStateNoWrite}, but distinguishes "nothing
 * stored" (state null, no error) from "stored but unreadable" (state null,
 * loadError set) — the backup export surfaces the latter so users know their
 * backup is missing recovery data.
 */
export async function readPaymentRequestStateNoWriteDetailed(
  storage: ReadOnlyStorage,
  chainId: number,
  ownerAddress: string,
): Promise<{ state: PaymentRequestServiceState | null; loadError: string | null }> {
  try {
    const raw = await storage.get<unknown>(paymentRequestStateKey(chainId, ownerAddress));
    if (raw == null) return { state: null, loadError: null };
    const parsed = PaymentRequestServiceStateSchema.safeParse(upgradeLegacyPaymentRequestState(raw));
    if (!parsed.success) {
      return { state: null, loadError: parsed.error.issues[0]?.message ?? 'invalid stored payment-request state' };
    }
    return { state: parsed.data, loadError: null };
  } catch (err) {
    return { state: null, loadError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Multi-chain no-write read — the card's data source. Same output shape as
 * the backup payload's `chains` map.
 */
export async function readAllPaymentRequestStatesNoWrite(
  storage: ReadOnlyStorage,
  chainIds: number[],
  ownerAddress: string,
): Promise<Record<string, PaymentRequestServiceState>> {
  const chains: Record<string, PaymentRequestServiceState> = {};
  for (const chainId of chainIds) {
    const state = await readPaymentRequestStateNoWrite(storage, chainId, ownerAddress);
    if (state?.requests.length) chains[String(chainId)] = state;
  }
  return chains;
}
