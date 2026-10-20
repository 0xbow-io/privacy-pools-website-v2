import { describe, expect, test } from 'bun:test';

import { indexCommitmentTimestamps, normalizeCommitment } from '../note-timestamp-heal';

/**
 * The bug this exists to prevent: a note that arrived by DEPOSIT could not be
 * dated, so it kept its `createdAtBlock: '0x0'` stub, so its state-tree leaf
 * was wrong, so it could never be anchored or spent. It imported cleanly and
 * failed later, which is the worst shape for a claim link to fail in.
 */

// Unix seconds, unix ms and ISO all occur in real snapshots.
const toMs = (v: unknown): number => {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
    const parsed = Date.parse(v);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const COMMITMENT = '0x000000000000000000000000000000000000000000000000000000000000beef';

describe('dating a commitment from the snapshot', () => {
  test('a DEPOSIT commitment is dated, which is the case that was missing', () => {
    const index = indexCommitmentTimestamps(
      { deposits: [{ txHash: '0xdep', blockTimestamp: 1789560000, outputCommitment: COMMITMENT }] },
      toMs,
    );
    expect(index.byCommitment.get(COMMITMENT)).toEqual({ txHash: '0xdep', ts: 1789560000n });
    expect(index.depositsIndexed).toBe(1);
  });

  test('a transact commitment is still dated', () => {
    const index = indexCommitmentTimestamps(
      { transacts: [{ txHash: '0xtx', blockTimestamp: 1789560000, outputCommitments: [COMMITMENT] }] },
      toMs,
    );
    expect(index.byCommitment.get(COMMITMENT)).toEqual({ txHash: '0xtx', ts: 1789560000n });
    expect(index.transactsIndexed).toBe(1);
  });

  test('both families are indexed in one pass', () => {
    const other = '0x00000000000000000000000000000000000000000000000000000000000000ff';
    const index = indexCommitmentTimestamps(
      {
        transacts: [{ txHash: '0xtx', blockTimestamp: 1789560000, outputCommitments: [other] }],
        deposits: [{ txHash: '0xdep', blockTimestamp: 1789561111, outputCommitment: COMMITMENT }],
      },
      toMs,
    );
    expect(index.byCommitment.size).toBe(2);
    expect(index.byCommitment.get(COMMITMENT)?.txHash).toBe('0xdep');
    expect(index.byCommitment.get(other)?.txHash).toBe('0xtx');
  });

  test('a commitment is matched however it was written', () => {
    // Snapshots hand back decimal strings, unpadded hex and mixed case.
    const index = indexCommitmentTimestamps(
      { deposits: [{ txHash: '0xdep', blockTimestamp: 1789560000, outputCommitment: '48879' }] },
      toMs,
    );
    expect(index.byCommitment.get(normalizeCommitment('0xBEEF'))).toBeDefined();
    expect(normalizeCommitment('48879')).toBe(COMMITMENT);
  });

  test('an unreadable timestamp is skipped and counted, never guessed', () => {
    // skippedRows is what turns off the caller's absence proof, so a deposit
    // row with a bad timestamp must count exactly like a transact one.
    const index = indexCommitmentTimestamps(
      {
        transacts: [{ txHash: '0xtx', blockTimestamp: 'not-a-date', outputCommitments: [COMMITMENT] }],
        deposits: [{ txHash: '0xdep', blockTimestamp: null, outputCommitment: COMMITMENT }],
      },
      toMs,
    );
    expect(index.skippedRows).toBe(2);
    expect(index.byCommitment.size).toBe(0);
  });

  test('missing sections and empty rows are not a crash', () => {
    expect(indexCommitmentTimestamps(undefined, toMs).byCommitment.size).toBe(0);
    expect(indexCommitmentTimestamps({}, toMs).skippedRows).toBe(0);
    const index = indexCommitmentTimestamps(
      {
        deposits: [{ txHash: '0xdep', blockTimestamp: 1789560000, outputCommitment: null }],
        transacts: [{ txHash: '0xtx', blockTimestamp: 1789560000, outputCommitments: null }],
      },
      toMs,
    );
    expect(index.byCommitment.size).toBe(0);
    // Readable rows that simply carried no commitment are NOT skips: absence
    // is still proven.
    expect(index.skippedRows).toBe(0);
  });
});
