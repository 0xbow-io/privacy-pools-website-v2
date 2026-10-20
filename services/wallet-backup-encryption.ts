import { loadSdkCore } from '@/services/crypto-runtime';
// Thin device-storage wiring around services/account-backup-core.ts (the
// pure envelope/crypto/merge core, which bun tests exercise directly with an
// in-memory store). This module supplies the REAL persistence:
//   load → the NO-WRITE reader (no migration side effects on export; retains
//          a legacy record's stored paymentPrivKey),
//   save → the SDK's owner-namespaced storage adapter + a revision bump so
//          the list widget reloads.

import type { PaymentRequestServiceState } from '@privacy-pools-v2/sdk';

import type { AccountExport } from '@/services/sdk-types';
import { getSdkStorageService } from '@/services/sdk-storage';
import { readPaymentRequestStateNoWriteDetailed } from '@/services/payment-request-store-read';
import { bumpPaymentRequestRevision } from '@/services/payment-request-revision';
import {
  encryptAccountExportCore,
  parseAccountBackupCore,
  prepareAccountBackupCore,
  type BackupEnvelope,
  type PasswordEncryptedPayload,
  type PaymentRequestStateStore,
  type PreparedAccountBackup,
} from '@/services/account-backup-core';

export type { PreparedAccountBackup } from '@/services/account-backup-core';

const deviceStore: PaymentRequestStateStore = {
  load(chainId: number, owner: string) {
    return readPaymentRequestStateNoWriteDetailed(getSdkStorageService(), chainId, owner);
  },
  async save(chainId: number, owner: string, state: PaymentRequestServiceState) {
    // The SDK namespaces payment-request storage by owner now, so the
    // backup/restore adapter MUST use the same address the live PoolSession
    // used or it would write a different storage slot. saveState spreads the
    // records, so a retained legacy paymentPrivKey survives the write.
    const { PaymentRequestStorageAdapter } = await loadSdkCore();
    const adapter = new PaymentRequestStorageAdapter(chainId, getSdkStorageService(), owner as `0x${string}`);
    await adapter.saveState(state);
    bumpPaymentRequestRevision();
  },
};

export async function encryptAccountExport(
  address: string,
  chainId: number,
  envelope: BackupEnvelope,
  password: string,
): Promise<PasswordEncryptedPayload> {
  return encryptAccountExportCore(address, chainId, envelope, password);
}

export async function prepareAccountBackup(
  address: string,
  chainId: number,
  accountExport: AccountExport,
  password?: string,
): Promise<PreparedAccountBackup> {
  return prepareAccountBackupCore(deviceStore, address, chainId, accountExport, password);
}

export async function parseAccountBackup(
  address: string,
  chainId: number,
  rawPayload: string,
  password?: string,
): Promise<AccountExport> {
  return parseAccountBackupCore(deviceStore, address, chainId, rawPayload, password);
}
