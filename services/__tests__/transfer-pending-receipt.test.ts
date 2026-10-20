import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sentAuditsForRow, transferPendingAuditKey } from '../audit-store-core';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

/**
 * DEV-413: a one-time transfer receipt must survive an unknown relay outcome.
 *
 * The receipt used to live only in React state until confirmation, so a relay
 * that never reported its hash left the history row with no "Copy payment
 * link", and the unregistered recipient's only claim route was lost.
 */

const d = (txHash: string, commitment: string) => ({
  chainId: 1,
  txHash,
  commitment,
  ownerAddress: '0x1111111111111111111111111111111111111111',
  noteSecret: '0x2222',
  tokenId: '0x3333333333333333333333333333333333333333',
  value: '0x1',
  label: '0x4444',
}) as never;

const store = (rows: never[]) => {
  return (key: string) => (rows as { txHash: string }[]).filter((r) => r.txHash.toLowerCase() === key.toLowerCase()) as never[];
};

describe('transferPendingAuditKey', () => {
  test('keys on the change note, which the sender later holds under the real hash', () => {
    expect(transferPendingAuditKey('0xCHANGE', ['0xrecip'])).toBe('pending:0xchange');
  });
  test('falls back to the first recipient note when there is no change', () => {
    expect(transferPendingAuditKey(null, ['0xRecip', '0xother'])).toBe('pending:0xrecip');
  });
  test('no commitments, no key', () => {
    expect(transferPendingAuditKey(undefined, [])).toBeNull();
  });
});

describe('sentAuditsForRow', () => {
  test('a record under the real hash wins', () => {
    const find = store([d('0xabc', '0xr1'), d('pending:0xchange', '0xr1')]);
    const rows = sentAuditsForRow('0xABC', ['0xchange'], find);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { txHash: string }).txHash).toBe('0xabc');
  });

  test('an unknown-outcome send is found through the row\'s change note, under the row\'s hash', () => {
    const find = store([d('pending:0xchange', '0xr1'), d('pending:0xchange', '0xr2')]);
    const rows = sentAuditsForRow('0xDEF', ['0xother', '0xCHANGE'], find) as unknown as { txHash: string; commitment: string }[];
    expect(rows.map((r) => r.commitment)).toEqual(['0xr1', '0xr2']);
    expect(rows.every((r) => r.txHash === '0xdef')).toBe(true);
  });

  test('a send with no change note is found through the row\'s snapshot outputs (Max / whole balance)', () => {
    const key = transferPendingAuditKey(null, ['0xRecip']);
    const find = store([d(key as string, '0xrecip')]);
    // No own note came out of this tx; the snapshot's outputs for it name the recipient note.
    const rowCommitments = ['0xrecip'];
    const rows = sentAuditsForRow('0xFEED', rowCommitments, find) as unknown as { txHash: string; commitment: string }[];
    expect(rows.map((r) => r.commitment)).toEqual(['0xrecip']);
    expect(rows[0].txHash).toBe('0xfeed');
  });

  test('a row whose notes match no record offers nothing', () => {
    const find = store([d('pending:0xchange', '0xr1')]);
    expect(sentAuditsForRow('0xdef', ['0xunrelated'], find)).toEqual([]);
    expect(sentAuditsForRow(null, ['0xchange'], find)).toEqual([]);
  });
});

describe('the transfer modal stores the receipt before it broadcasts', () => {
  const src = readFileSync(join(ROOT, 'components/transfer-modal-provider.tsx'), 'utf8');

  test('the provisional record is written before relayTransfer and before the direct send', () => {
    // The persistence call itself (the verified write under the pending key),
    // not the key derivation, so moving the write after broadcast fails here.
    const write = src.indexOf('recordSentAuditsVerified(result.recipientDisclosures.map((d) => ({\n            chainId,\n            txHash: pendingKey as Hash,');
    expect(write).toBeGreaterThan(-1);
    expect(src.indexOf('provisionalAuditKey = transferPendingAuditKey(')).toBeLessThan(write);
    expect(write).toBeLessThan(src.indexOf('relay: (option) => session.relayTransfer(option)'));
    expect(write).toBeLessThan(src.indexOf('hash = (await sendTransactionAsync({'));
  });

  test('success re-keys it only after the real record is verified', () => {
    expect(src).toContain('if (kept && provisionalAuditKey) dropSentAudits(provisionalAuditKey);');
  });

  test('the history row reads through the fallback', () => {
    const rows = readFileSync(join(ROOT, 'components/pools/transactions.tsx'), 'utf8');
    expect(rows).toContain('findSentAuditsForRow(tx.txHash, rowNoteCommitments)');
    // The no-change case needs the tx's outputs, not only the sender's notes.
    expect(rows).toContain('data.transactOutputsByTx?.get(tx.txHash.toLowerCase())');
  });
});
