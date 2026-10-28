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
  type AddressBookImportResult,
  type AddressBookStore,
  type BackupEnvelope,
  type PasswordEncryptedPayload,
  type PaymentRequestStateStore,
  type PreparedAccountBackup,
} from '@/services/account-backup-core';
import { mergeAddressBookBackup } from '@/services/address-book-core';
import { readContacts, readRecipientRecords, writeContacts, writeRecipientRecords } from '@/services/address-book-store';

export type { AddressBookImportResult, PreparedAccountBackup } from '@/services/account-backup-core';

/** The owner's saved names and recipient history (plus the device bucket), for the encrypted backup. */
const deviceAddressBook: AddressBookStore = {
  load(owner: string) {
    return { contacts: readContacts(owner), recipients: [...readRecipientRecords(null), ...readRecipientRecords(owner)] };
  },
  restore(owner: string, backup) {
    const merged = mergeAddressBookBackup({ contacts: readContacts(owner), recipients: readRecipientRecords(owner) }, backup, Date.now());
    writeContacts(owner, merged.contacts);
    writeRecipientRecords(owner, merged.recipients);
    return { added: merged.added };
  },
};

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
  return prepareAccountBackupCore(deviceStore, address, chainId, accountExport, password, deviceAddressBook);
}

export async function parseAccountBackup(
  address: string,
  chainId: number,
  rawPayload: string,
  password?: string,
  onAddressBook?: (result: AddressBookImportResult) => void,
): Promise<AccountExport> {
  return parseAccountBackupCore(deviceStore, address, chainId, rawPayload, password, deviceAddressBook, onAddressBook);
}
