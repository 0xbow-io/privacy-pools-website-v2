import { describe, expect, test } from 'bun:test';

import {
  decodeStellarRequestBackup,
  encodeStellarRequestBackup,
  isStellarBackupPayload,
  isStellarRequestBackupPayload,
  mergeStellarRequestRecords,
} from '@/services/stellar/stellar-backup';
import { saveWithProof } from '@/services/backup-file-proof';
import {
  holdsSameRecoveryData,
  markStellarRequestsBackedUp,
  markStellarRequestsHeldByBackup,
  purgeBackedUpStellarRequests,
  readStoredStellarRequests,
  stellarRequestStorageKey,
  writeStoredStellarRequests,
} from '@/services/stellar/stellar-request-storage';

const ME = 'GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR';
const OTHER = 'GCFONE23AB7Y6C5YZOMKUKGETPIAJA4QOYLS5VNS4JHBGKRZCPYHDLW7';
const CHAIN = 202;
const PID_A = `0x${'a'.repeat(64)}`;
const PID_B = `0x${'b'.repeat(64)}`;

// The shape the SDK's exportAccount().paymentRequests carries.
const record = (paymentId: string, owner = ME, status = 'OPEN') => ({
  paymentId,
  noteAddressHashes: ['0x01'],
  noteSecretsMap: [['0x01', '0x02']],
  amount: '0x64',
  tokenId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  tag: '0x03',
  paymentPubKey: '0x04',
  recipientAddress: owner,
  status,
  createdAt: '0x1',
  fulfilledByCommitments: [],
});
const row = (paymentId: string, owner = ME) => ({
  requestId: paymentId.slice(2), chainId: CHAIN, owner: owner.toLowerCase(), tokenAddress: 'C', amount: '0x64',
  createdAtMs: 1, payLink: null, signed: false,
});

function fakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

const ids = (records: readonly unknown[]) => records.map((r) => (r as { paymentId: string }).paymentId);

describe('Stellar payment requests in localStorage', () => {
  test('a reload restores the requests into a fresh session export', () => {
    const storage = fakeStorage();
    expect(writeStoredStellarRequests(CHAIN, ME, { records: [record(PID_A)], rows: [row(PID_A)] }, storage, 'prod')).toBe(true);

    // New tab: nothing in the tab copy, the session starts empty.
    const kept = readStoredStellarRequests(CHAIN, ME, storage, 'prod');
    expect(ids(kept.records)).toEqual([PID_A]);
    expect(kept.rows.map((r) => r.requestId)).toEqual([PID_A.slice(2)]);
    const fresh = { notes: [] as { commitment: string }[], syncCursor: '0x0', paymentRequests: [] as unknown[] };
    const { merged, added } = mergeStellarRequestRecords(fresh, kept.records);
    expect(added).toBe(1);
    expect(ids(merged.paymentRequests ?? [])).toEqual([PID_A]);
    // The note secrets come back as stored (EVM keeps them the same way).
    expect((merged.paymentRequests?.[0] as { noteSecretsMap: unknown }).noteSecretsMap).toEqual([['0x01', '0x02']]);
  });

  test('another owner or another environment cannot read them', () => {
    const storage = fakeStorage();
    writeStoredStellarRequests(CHAIN, ME, { records: [record(PID_A)], rows: [row(PID_A)] }, storage, 'prod');
    expect(readStoredStellarRequests(CHAIN, OTHER, storage, 'prod')).toEqual({ records: [], rows: [], backedUp: [] });
    expect(readStoredStellarRequests(CHAIN, ME, storage, 'staging')).toEqual({ records: [], rows: [], backedUp: [] });
    expect(readStoredStellarRequests(1, ME, storage, 'prod').records).toEqual([]);
    // Keys follow the EVM scoping: owner and chain in the key, prod suffixed, staging bare.
    expect(stellarRequestStorageKey(CHAIN, ME, 'prod')).toBe(`v1:stellar-payment-request-state:202:${ME}_prod`);
    expect(stellarRequestStorageKey(CHAIN, ME, 'staging')).toBe(`v1:stellar-payment-request-state:202:${ME}`);
  });

  test('a record naming another owner under this key is ignored', () => {
    const storage = fakeStorage();
    storage.setItem(stellarRequestStorageKey(CHAIN, ME, 'prod'), JSON.stringify({ records: [record(PID_A, OTHER), record(PID_B)], rows: [row(PID_A, OTHER)] }));
    const kept = readStoredStellarRequests(CHAIN, ME, storage, 'prod');
    expect(ids(kept.records)).toEqual([PID_B]);
    expect(kept.rows).toEqual([]);
  });

  test('writes only add, and the newer copy of a record wins', () => {
    const storage = fakeStorage();
    writeStoredStellarRequests(CHAIN, ME, { records: [record(PID_A)] }, storage, 'prod');
    // A later export without A (a restore that failed) must not erase it.
    writeStoredStellarRequests(CHAIN, ME, { records: [record(PID_B)] }, storage, 'prod');
    writeStoredStellarRequests(CHAIN, ME, { records: [record(PID_A, ME, 'FULFILLED')] }, storage, 'prod');
    const kept = readStoredStellarRequests(CHAIN, ME, storage, 'prod');
    expect(ids(kept.records).sort()).toEqual([PID_A, PID_B]);
    expect((kept.records.find((r) => (r as { paymentId: string }).paymentId === PID_A) as { status: string }).status).toBe('FULFILLED');
  });

  test('a stale OPEN copy never replaces a FULFILLED one', () => {
    const storage = fakeStorage();
    writeStoredStellarRequests(CHAIN, ME, { records: [record(PID_A, ME, 'FULFILLED')] }, storage, 'prod');
    // Another tab, still holding the request as OPEN, saves its export.
    writeStoredStellarRequests(CHAIN, ME, { records: [record(PID_A)] }, storage, 'prod');
    const kept = readStoredStellarRequests(CHAIN, ME, storage, 'prod');
    expect((kept.records[0] as { status: string }).status).toBe('FULFILLED');
  });

  test('a damaged record, or one naming no owner, is dropped instead of failing the import', () => {
    const storage = fakeStorage();
    const { recipientAddress: _omit, ...noOwner } = record(PID_A);
    const noSlots = { ...record(PID_B), noteSecretsMap: [] };
    const good = record(`0x${'c'.repeat(64)}`);
    storage.setItem(stellarRequestStorageKey(CHAIN, ME, 'prod'), JSON.stringify({ records: [noOwner, noSlots, good] }));
    expect(ids(readStoredStellarRequests(CHAIN, ME, storage, 'prod').records)).toEqual([good.paymentId]);
    const file = decodeStellarRequestBackup(
      encodeStellarRequestBackup({ chainId: CHAIN, owner: ME, records: [noOwner, noSlots, good], requests: [] }),
      { owner: ME, chainId: CHAIN },
    );
    expect(ids(file.records)).toEqual([good.paymentId]);
  });

  test('a refused write reports failure', () => {
    const storage = { ...fakeStorage(), setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(writeStoredStellarRequests(CHAIN, ME, { records: [record(PID_A)] }, storage, 'prod')).toBe(false);
    expect(writeStoredStellarRequests(CHAIN, ME, { records: [record(PID_A)] }, null, 'prod')).toBe(false);
  });
});

describe('sign-out purge', () => {
  test('removes only this owner\'s backed-up requests, everything else survives', () => {
    const storage = fakeStorage();
    writeStoredStellarRequests(CHAIN, ME, { records: [record(PID_A), record(PID_B)], rows: [row(PID_A), row(PID_B)] }, storage, 'prod');
    writeStoredStellarRequests(CHAIN, OTHER, { records: [record(PID_A, OTHER)], rows: [row(PID_A, OTHER)] }, storage, 'prod');
    writeStoredStellarRequests(CHAIN, ME, { records: [record(PID_A)] }, storage, 'staging');
    markStellarRequestsBackedUp(CHAIN, OTHER, [PID_A], storage, 'prod');
    markStellarRequestsBackedUp(CHAIN, ME, [PID_A], storage, 'staging');
    storage.setItem('ppv2_session_payment_requests_v1', '[]');
    storage.setItem('v1:payment-request-state:1:0xabc', '{}');

    // Only A went into a downloaded file.
    markStellarRequestsBackedUp(CHAIN, ME, [PID_A], storage, 'prod');
    expect(purgeBackedUpStellarRequests(CHAIN, ME, storage, 'prod')).toBe(1);

    const mine = readStoredStellarRequests(CHAIN, ME, storage, 'prod');
    expect(ids(mine.records)).toEqual([PID_B]);
    expect(mine.rows.map((r) => r.requestId)).toEqual([PID_B.slice(2)]);
    expect(ids(readStoredStellarRequests(CHAIN, OTHER, storage, 'prod').records)).toEqual([PID_A]);
    expect(ids(readStoredStellarRequests(CHAIN, ME, storage, 'staging').records)).toEqual([PID_A]);
    expect(storage.getItem('ppv2_session_payment_requests_v1')).toBe('[]');
    expect(storage.getItem('v1:payment-request-state:1:0xabc')).toBe('{}');
  });

  test('a request no file holds stays; once all are backed up the key goes', () => {
    const storage = fakeStorage();
    writeStoredStellarRequests(CHAIN, ME, { records: [record(PID_A)], rows: [row(PID_A)] }, storage, 'prod');
    expect(purgeBackedUpStellarRequests(CHAIN, ME, storage, 'prod')).toBe(0);
    expect(ids(readStoredStellarRequests(CHAIN, ME, storage, 'prod').records)).toEqual([PID_A]);
    // An id the store does not hold is not recorded as backed up.
    markStellarRequestsBackedUp(CHAIN, ME, [PID_B], storage, 'prod');
    expect(readStoredStellarRequests(CHAIN, ME, storage, 'prod').backedUp).toEqual([]);
    markStellarRequestsBackedUp(CHAIN, ME, [PID_A.toUpperCase().replace('0X', '0x')], storage, 'prod');
    expect(purgeBackedUpStellarRequests(CHAIN, ME, storage, 'prod')).toBe(1);
    expect(storage.map.has(stellarRequestStorageKey(CHAIN, ME, 'prod'))).toBe(false);
  });
});

describe('Stellar request backup file', () => {
  test('round trip, and it is not the sealed account backup', () => {
    const raw = encodeStellarRequestBackup({ chainId: CHAIN, owner: ME, records: [record(PID_A)], requests: [row(PID_A)] });
    expect(isStellarRequestBackupPayload(raw)).toBe(true);
    expect(isStellarBackupPayload(raw)).toBe(false);
    const file = decodeStellarRequestBackup(raw, { owner: ME, chainId: CHAIN });
    expect(ids(file.records)).toEqual([PID_A]);
    expect(file.requests.map((r) => r.requestId)).toEqual([PID_A.slice(2)]);
  });

  test('refuses another account or network, drops foreign records and rows', () => {
    const raw = encodeStellarRequestBackup({
      chainId: CHAIN, owner: ME, records: [record(PID_A), record(PID_B, OTHER), { junk: true }], requests: [row(PID_A), row(PID_B, OTHER)],
    });
    expect(() => decodeStellarRequestBackup(raw, { owner: OTHER, chainId: CHAIN })).toThrow('another Stellar account');
    expect(() => decodeStellarRequestBackup(raw, { owner: ME, chainId: 1 })).toThrow('another network');
    const file = decodeStellarRequestBackup(raw, { owner: ME, chainId: CHAIN });
    expect(ids(file.records)).toEqual([PID_A]);
    expect(file.requests.map((r) => r.requestId)).toEqual([PID_A.slice(2)]);
  });

  test('an import merges without duplicates, the live copy wins', () => {
    const live = {
      notes: [{ commitment: '0x9' }],
      syncCursor: '0x500',
      paymentRequests: [record(PID_A, ME, 'FULFILLED')] as unknown[],
    };
    const file = decodeStellarRequestBackup(
      encodeStellarRequestBackup({ chainId: CHAIN, owner: ME, records: [record(PID_A), record(PID_B), record(PID_B)], requests: [] }),
      { owner: ME, chainId: CHAIN },
    );
    const { merged, added } = mergeStellarRequestRecords(live, file.records);
    expect(added).toBe(1);
    expect(ids(merged.paymentRequests ?? [])).toEqual([PID_A, PID_B]);
    expect((merged.paymentRequests?.[0] as { status: string }).status).toBe('FULFILLED');
    expect(merged.notes).toEqual(live.notes);
    // Payments to the added request may predate the cursor: the next sync re-checks.
    expect(merged.syncCursor).toBe('0x0');

    // The same file again adds nothing and leaves the export as is.
    const again = mergeStellarRequestRecords(merged, file.records);
    expect(again.added).toBe(0);
    expect(again.merged).toBe(merged);
  });
});

// The proof model of PR #209: a request counts as backed up only when the
// save-file picker wrote and closed the file, a native share completed, or an
// imported backup holds the same recovery data. A press or a plain download
// marks nothing.
describe('what counts as a backup before the sign-out purge', () => {
  const seed = (storage: ReturnType<typeof fakeStorage>) =>
    writeStoredStellarRequests(CHAIN, ME, { records: [record(PID_A)], rows: [row(PID_A)] }, storage, 'prod');
  const backupText = () => encodeStellarRequestBackup({ chainId: CHAIN, owner: ME, records: [record(PID_A)], requests: [row(PID_A)] });

  test('a press without a confirmed save keeps the record', async () => {
    const storage = fakeStorage();
    seed(storage);
    // No picker: the caller falls back to its plain download, which proves nothing.
    expect(await saveWithProof({}, backupText(), 'b.json')).toBe('unproven');
    // The picker dismissed: nothing written.
    const abort = Object.assign(new Error('dismissed'), { name: 'AbortError' });
    expect(await saveWithProof({ showSaveFilePicker: () => Promise.reject(abort) }, backupText(), 'b.json')).toBe('cancelled');
    // A write that fails before close.
    const broken = { showSaveFilePicker: async () => ({ createWritable: async () => ({ write: async () => { throw new Error('disk'); }, close: async () => undefined }) }) };
    expect(await saveWithProof(broken, backupText(), 'b.json')).toBe('unproven');
    expect(purgeBackedUpStellarRequests(CHAIN, ME, storage, 'prod')).toBe(0);
    expect(ids(readStoredStellarRequests(CHAIN, ME, storage, 'prod').records)).toEqual([PID_A]);
  });

  test('a picker save that wrote and closed the file lets sign-out purge it', async () => {
    const storage = fakeStorage();
    seed(storage);
    const written: string[] = [];
    let closed = false;
    const host = { showSaveFilePicker: async () => ({ createWritable: async () => ({ write: async (t: string) => { written.push(t); }, close: async () => { closed = true; } }) }) };
    const result = await saveWithProof(host, backupText(), 'b.json');
    expect(result).toBe('saved');
    expect(closed).toBe(true);
    expect(written).toHaveLength(1);
    expect(isStellarRequestBackupPayload(written[0])).toBe(true);
    // What the app does on 'saved' (stellarAccount.markRequestBackupSaved).
    markStellarRequestsBackedUp(CHAIN, ME, [PID_A], storage, 'prod');
    expect(purgeBackedUpStellarRequests(CHAIN, ME, storage, 'prod')).toBe(1);
    expect(storage.map.has(stellarRequestStorageKey(CHAIN, ME, 'prod'))).toBe(false);
  });

  test('an import with the same recovery data counts', () => {
    const storage = fakeStorage();
    seed(storage);
    const file = decodeStellarRequestBackup(backupText(), { owner: ME, chainId: CHAIN });
    expect(markStellarRequestsHeldByBackup(CHAIN, ME, file.records, storage, 'prod')).toBe(1);
    expect(purgeBackedUpStellarRequests(CHAIN, ME, storage, 'prod')).toBe(1);
  });

  test('an import with the same paymentId but other note secrets does not', () => {
    const storage = fakeStorage();
    seed(storage);
    const other = { ...record(PID_A), noteSecretsMap: [['0x01', '0x99']] };
    expect(holdsSameRecoveryData(record(PID_A), other)).toBe(false);
    expect(holdsSameRecoveryData(record(PID_A), record(PID_A))).toBe(true);
    expect(markStellarRequestsHeldByBackup(CHAIN, ME, [other], storage, 'prod')).toBe(0);
    // A record the store does not hold marks nothing either.
    expect(markStellarRequestsHeldByBackup(CHAIN, ME, [record(PID_B)], storage, 'prod')).toBe(0);
    expect(purgeBackedUpStellarRequests(CHAIN, ME, storage, 'prod')).toBe(0);
    expect(ids(readStoredStellarRequests(CHAIN, ME, storage, 'prod').records)).toEqual([PID_A]);
  });
});
