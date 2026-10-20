import { describe, expect, test } from 'bun:test';

import {
  decodeStellarBackup,
  encodeStellarBackup,
  isStellarBackupPayload,
  mergeStellarExports,
} from '@/services/stellar/stellar-backup';

const ME = 'GAIH3ULLFQ4DGSECF2AR555KZ4KNDGEKN4AFI4SU2M7B43MGK3QJZNSR';
const OTHER = 'GCFONE23AB7Y6C5YZOMKUKGETPIAJA4QOYLS5VNS4JHBGKRZCPYHDLW7';
const SEALED = { v: 1, kdf: { name: 'scrypt' }, salt: '0xaa', ciphertext: '0xbb' };
const request = (id: string, owner = ME.toLowerCase()) => ({
  requestId: id, chainId: 202, owner, tokenAddress: 'C', amount: '0x1', createdAtMs: 1, payLink: null, signed: false,
});

describe('Stellar backup file', () => {
  test('round trip for the same account', () => {
    const raw = encodeStellarBackup({ chainId: 202, owner: ME, sealed: SEALED, requests: [request('req-1')] });
    expect(isStellarBackupPayload(raw)).toBe(true);
    const file = decodeStellarBackup(raw, { owner: ME, chainId: 202 });
    expect(file.sealed).toEqual(SEALED);
    expect(file.requests.map((r) => r.requestId)).toEqual(['req-1']);
  });

  test('refuses another account, another network, and foreign request rows', () => {
    const raw = encodeStellarBackup({ chainId: 202, owner: ME, sealed: SEALED, requests: [request('req-1'), request('req-2', OTHER.toLowerCase())] });
    expect(() => decodeStellarBackup(raw, { owner: OTHER, chainId: 202 })).toThrow('another Stellar account');
    expect(() => decodeStellarBackup(raw, { owner: ME, chainId: 1 })).toThrow('another network');
    expect(decodeStellarBackup(raw, { owner: ME, chainId: 202 }).requests.map((r) => r.requestId)).toEqual(['req-1']);
  });

  test('an EVM backup or junk is not a Stellar backup', () => {
    expect(isStellarBackupPayload(JSON.stringify({ kind: 'ppv2-password-backup', version: 2 }))).toBe(false);
    expect(isStellarBackupPayload('not json')).toBe(false);
    expect(() => decodeStellarBackup('{"kind":"ppv2-stellar-backup","version":1,"chainId":202,"owner":"' + ME + '"}', { owner: ME, chainId: 202 })).toThrow('damaged');
  });
});

describe('mergeStellarExports', () => {
  test('keeps every live note as is, adds backup-only notes, rewinds the cursor', () => {
    const live = { notes: [{ commitment: '0x01', status: 'SPENT' }, { commitment: '0x03', status: 'ACTIVE' }], syncCursor: '0x200', owner: ME };
    const restored = { notes: [{ commitment: '0x0001', status: 'ACTIVE' }, { commitment: '0x02', status: 'ACTIVE' }], syncCursor: '0x100' };
    const merged = mergeStellarExports(live, restored);
    expect(merged.notes).toEqual([
      { commitment: '0x01', status: 'SPENT' },
      { commitment: '0x03', status: 'ACTIVE' },
      { commitment: '0x02', status: 'ACTIVE' },
    ]);
    expect(merged.syncCursor).toBe('0x100');
    expect(merged.owner).toBe(ME);
  });
});

describe('Stellar backup request rows', () => {
  test('malformed rows are dropped and unknown fields stripped', () => {
    const good = { ...request('req-ok'), payLink: 'https://v2.privacypools.com/pay/xlm.abc?stellar=true', extra: 'x' };
    const rows = [
      good,
      { ...request('req-bad1'), amount: 'lots' },
      { ...request('req-bad2'), createdAtMs: 'yesterday' },
      { ...request('req-bad4'), signed: 'no' },
      { ...request('req-bad5'), tokenAddress: 7 },
      null,
    ];
    const raw = encodeStellarBackup({ chainId: 202, owner: ME, sealed: SEALED, requests: rows as never });
    const restored = decodeStellarBackup(raw, { owner: ME, chainId: 202, linkOrigins: ['https://v2.privacypools.com'] }).requests;
    expect(restored.map((r) => r.requestId)).toEqual(['req-ok']);
    expect(Object.keys(restored[0]).sort()).toEqual(['amount', 'chainId', 'createdAtMs', 'owner', 'payLink', 'requestId', 'signed', 'tokenAddress']);
  });
});

describe('Stellar backup pay links', () => {
  test('a link from another origin, or not a pay link, is dropped and the row kept', () => {
    const rows = [
      { ...request('req-ours'), payLink: 'https://v2.privacypools.com/pay/xlm.abc' },
      { ...request('req-evil'), payLink: 'https://evil.example/pay/xlm.abc' },
      { ...request('req-js'), payLink: 'javascript:alert(1)' },
    ];
    const raw = encodeStellarBackup({ chainId: 202, owner: ME, sealed: SEALED, requests: rows as never });
    const restored = decodeStellarBackup(raw, { owner: ME, chainId: 202, linkOrigins: ['https://v2.privacypools.com'] }).requests;
    expect(restored.map((r) => [r.requestId, r.payLink])).toEqual([
      ['req-ours', 'https://v2.privacypools.com/pay/xlm.abc'],
      ['req-evil', null],
      ['req-js', null],
    ]);
  });
});

describe('mergeStellarExports: blind payment requests', () => {
  const rec = (paymentId: string, status = 'OPEN') => ({ paymentId, status });
  test('keeps every request only the backup has, and the live copy of one both have', () => {
    const live = { notes: [], syncCursor: '0x10', paymentRequests: [rec('0xAA', 'FULFILLED')] };
    const restored = { notes: [], syncCursor: '0x5', paymentRequests: [rec('0xaa'), rec('0xbb')] };
    const merged = mergeStellarExports(live, restored);
    expect(merged.paymentRequests).toEqual([rec('0xAA', 'FULFILLED'), rec('0xbb')]);
    expect(merged.syncCursor).toBe('0x5');
  });

  test('a backup with requests restores them into a session that has none', () => {
    const live: { notes: { commitment: string }[]; syncCursor: string; paymentRequests?: unknown[] } = { notes: [], syncCursor: '0x1' };
    const merged = mergeStellarExports(live, { notes: [] as { commitment: string }[], syncCursor: '0x1', paymentRequests: [rec('0xcc')] });
    expect(merged.paymentRequests).toEqual([rec('0xcc')]);
  });
});
