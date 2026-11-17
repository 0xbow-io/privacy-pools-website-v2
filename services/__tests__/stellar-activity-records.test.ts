import { describe, expect, test } from 'bun:test';

import { readClaimedNotes, readDepositsFor, recordClaimedNotes, recordDepositFor } from '@/services/stellar/stellar-activity-records';

function memory() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
}

describe('stellar activity records', () => {
  test('deposit-for: replace by tx hash, scoped to the depositor', () => {
    const s = memory();
    recordDepositFor(s, 'k', { depositor: 'GA', txHash: 'abc', createdAt: 1 });
    recordDepositFor(s, 'k', { depositor: 'GA', txHash: '0xABC', createdAt: 2 });
    recordDepositFor(s, 'k', { depositor: 'GC', txHash: 'def', createdAt: 3 });
    expect(readDepositsFor(s, 'k', 'GA')).toEqual([{ depositor: 'GA', txHash: '0xABC', createdAt: 2 }]);
    expect(readDepositsFor(s, 'k')).toHaveLength(2);
  });

  test('deposit-for keeps no recipient or amount, even from an older stored shape', () => {
    const s = memory();
    s.setItem('k', JSON.stringify([{ depositor: 'GA', recipient: 'GB', amount: '1', txHash: 'abc', createdAt: 1 }]));
    expect(readDepositsFor(s, 'k')).toEqual([{ depositor: 'GA', txHash: 'abc', createdAt: 1 }]);
    recordDepositFor(s, 'k', { depositor: 'GA', txHash: 'def', createdAt: 2 });
    expect(s.getItem('k')).not.toContain('GB');
  });

  test('claimed: first claim time wins, scoped to the owner', () => {
    const s = memory();
    recordClaimedNotes(s, 'k', [{ owner: 'GA', commitment: '0x0a', txHash: 't', claimedAt: 1 }]);
    recordClaimedNotes(s, 'k', [{ owner: 'GA', commitment: '0x000a', txHash: 't', claimedAt: 2 }]);
    expect(readClaimedNotes(s, 'k', 'GA')).toEqual([{ owner: 'GA', commitment: '0x0a', txHash: 't', claimedAt: 1 }]);
    expect(readClaimedNotes(s, 'k', 'GB')).toEqual([]);
  });

  test('unreadable storage reads as empty', () => {
    const s = memory();
    s.setItem('k', '{bad');
    expect(readDepositsFor(s, 'k')).toEqual([]);
    expect(readClaimedNotes(null, 'k')).toEqual([]);
  });
});

describe('stellar activity records notify subscribers', () => {
  test('a recorded deposit-for or claim bumps the version and calls listeners', async () => {
    const { getStellarActivityRecordsVersion, subscribeStellarActivityRecords } = await import('@/services/stellar/stellar-activity-records');
    const s = memory();
    let calls = 0;
    const off = subscribeStellarActivityRecords(() => { calls += 1; });
    const before = getStellarActivityRecordsVersion();
    recordDepositFor(s, 'k', { depositor: 'GA', txHash: 'abc', createdAt: 1 });
    recordClaimedNotes(s, 'c', [{ owner: 'GA', commitment: '0x1', txHash: 't', claimedAt: 1 }]);
    expect(getStellarActivityRecordsVersion()).toBe(before + 2);
    expect(calls).toBe(2);
    // Nothing new to record: no notification.
    recordClaimedNotes(s, 'c', [{ owner: 'GA', commitment: '0x1', txHash: 't', claimedAt: 2 }]);
    expect(calls).toBe(2);
    off();
    recordDepositFor(s, 'k', { depositor: 'GA', txHash: 'def', createdAt: 2 });
    expect(calls).toBe(2);
  });
});
