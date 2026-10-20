// App glue for the sign-out purge (services/payment-request-signout-purge.ts
// holds the logic and its reasoning). Kept out of the provider so every
// sign-out path calls one function.

import { Platform } from 'react-native';

import { getSupportedChains } from '@/config/chains';
import { paymentRequestStateKey } from '@/services/payment-request-store-read';
import { bumpPaymentRequestRevision } from '@/services/payment-request-revision';
import {
  type PurgeResult,
  allowPaymentRequestWrites,
  blockPaymentRequestWrites,
  ledgerDeliveredBackup,
  markPaymentRequestsBackedUp,
  purgeOwnerPaymentRequests,
} from '@/services/payment-request-signout-purge';
import {
  getPaymentRequestPurgeStorage,
  getSdkStorageService,
  listOwnerPaymentRequestKeys,
  parseWithMaps,
} from '@/services/sdk-storage';

export { allowPaymentRequestWrites };

import {
  type BackupFileTarget,
  type PickerHost,
  canProveSave,
  openBackupFileTarget,
  saveWithProof,
  writeBackupFileTarget,
} from '@/services/backup-file-proof';

function pickerHost(): PickerHost {
  return Platform.OS === 'web' && typeof window !== 'undefined' ? (window as PickerHost) : undefined;
}

/**
 * Whether this browser can confirm a save (the File System Access picker).
 * Synchronous on purpose: a caller without it must run its plain download
 * BEFORE yielding, while the press's activation is still live.
 */
export function canProveBackupSave(): boolean {
  return canProveSave(pickerHost());
}

/**
 * Save a backup file and PROVE it was written (services/backup-file-proof.ts).
 * 'unproven' means the caller falls back to its plain download, which covers
 * nothing. Call it straight from a press: the picker needs the gesture.
 */
export function saveBackupWithProof(text: string, suggestedName: string): Promise<'saved' | 'cancelled' | 'unproven'> {
  return saveWithProof(pickerHost(), text, suggestedName);
}

/**
 * Open the save target NOW, from the press, for a backup whose content does
 * not exist yet; write it later with writeBackupFileTarget().
 */
export function openBackupFileTargetFromPress(suggestedName: string): Promise<BackupFileTarget | 'cancelled' | null> {
  return openBackupFileTarget(pickerHost(), suggestedName);
}

export { writeBackupFileTarget };
export type { BackupFileTarget };

/**
 * Record that a payment-request backup (its serialized text) reached the
 * user, so sign-out may purge the records it holds. Call it only on proof:
 * saveBackupWithProof() returned 'saved', or iOS reported a completed share.
 * `owner` is the account the backup was EXPORTED for. Best-effort.
 */
export async function notePaymentRequestBackupDelivered(owner: string | null | undefined, backupText: string | null): Promise<void> {
  if (!owner || !backupText) return;
  try {
    await ledgerDeliveredBackup(getSdkStorageService(), owner, backupText, parseWithMaps);
  } catch {
    // A missing ledger entry only costs a backup download at sign-out.
  }
}

/** Ledger entry for records that came FROM a backup the user holds. */
export async function notePaymentRequestsImportedFromBackup(owner: string, paymentIds: readonly string[]): Promise<void> {
  try {
    await markPaymentRequestsBackedUp(getSdkStorageService(), owner, paymentIds);
  } catch {
    // see above
  }
}

/**
 * Sign-out purge for ONE owner in the active environment: blocks further
 * writes to that owner's records (a torn-down session may still finish a
 * save), then removes every record a backup is known to exist for. A record
 * with no known backup is KEPT: sign-out never deletes the only copy, and an
 * unrequested download at sign-out could not prove it was saved either.
 * Other owners' and unrelated keys are never touched.
 */
export async function purgePaymentRequestsOnSignOut(owner: string): Promise<PurgeResult> {
  blockPaymentRequestWrites(owner);
  const keys = listOwnerPaymentRequestKeys(owner)
    ?? getSupportedChains().map((chain) => paymentRequestStateKey(chain.id, owner));
  const result = await purgeOwnerPaymentRequests(
    getPaymentRequestPurgeStorage(),
    owner,
    keys,
  );
  bumpPaymentRequestRevision();
  return result;
}
