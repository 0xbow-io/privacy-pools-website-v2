import { describe, test, expect } from 'bun:test';

// Pure module — no config/SDK/react-native imports, so no mocks needed.
import { newestSnapshotRowBlock, noteEventsFromSnapshot, snapshotCursor } from '@/services/asp-event-snapshot';

describe('snapshotCursor', () => {
  test('reads the ASP indexer head as a bigint', () => {
    // The payload endpoint serves decimal, note-events serves hex — both reach here.
    expect(snapshotCursor({ snapshotBlockNumber: '155818032' })).toBe(155818032n);
    expect(snapshotCursor({ snapshotBlockNumber: 155818032 })).toBe(155818032n);
    expect(snapshotCursor({ snapshotBlockNumber: '0x9499470' })).toBe(0x9499470n);
  });

  test('treats a 0 / missing / unreadable cursor as "authorises nothing"', () => {
    // asp-v2 reports 0 for a section with no last_synced_block row — the caller
    // must then scan the whole range from RPC, not skip to block 0.
    expect(snapshotCursor({ snapshotBlockNumber: '0' })).toBeNull();
    expect(snapshotCursor({ snapshotBlockNumber: '' })).toBeNull();
    expect(snapshotCursor({ snapshotBlockNumber: null })).toBeNull();
    expect(snapshotCursor({ snapshotBlockNumber: 'not-a-number' })).toBeNull();
    expect(snapshotCursor({})).toBeNull();
    expect(snapshotCursor(null)).toBeNull();
    expect(snapshotCursor(undefined)).toBeNull();
    expect(snapshotCursor('nonsense')).toBeNull();
  });
});

describe('newestSnapshotRowBlock — coverage the ASP actually proved', () => {
  const row = (blockNumber?: string) => ({ blockNumber });

  test('takes the newest block named by any section', () => {
    expect(newestSnapshotRowBlock({
      deposits: [row('100'), row('250')],
      transacts: [row('180')],
      ragequits: [row('90')],
    })).toBe(250n);
  });

  // The pre-merge version threaded a hook through the three merge loops and the
  // ragequit branch was the one lost in a rewrite. A ragequit alone must count.
  test('a ragequit row alone proves coverage', () => {
    expect(newestSnapshotRowBlock({ deposits: [], transacts: [], ragequits: [row('77')] })).toBe(77n);
  });

  test('reads hex as well as decimal, and ignores an unreadable row', () => {
    expect(newestSnapshotRowBlock({ deposits: [row('0x64')] })).toBe(100n);
    expect(newestSnapshotRowBlock({ deposits: [row('0x64'), row('nonsense')] })).toBe(100n);
  });

  // "No row names a block" and "no rows at all" are the same answer: the
  // snapshot proves nothing, so the caller must not skip any history.
  test('proves nothing without rows that name a block', () => {
    expect(newestSnapshotRowBlock({ deposits: [row()], transacts: [row()], ragequits: [] })).toBeNull();
    expect(newestSnapshotRowBlock({ deposits: [], transacts: [], ragequits: [] })).toBeNull();
    expect(newestSnapshotRowBlock({})).toBeNull();
    expect(newestSnapshotRowBlock(null)).toBeNull();
    expect(newestSnapshotRowBlock(undefined)).toBeNull();
  });

  // Deliberate split, and the thing a future reader is most likely to "fix":
  // snapshotCursor answers what the server CLAIMS, which is what the leaf sweep
  // needs to resume a quiet pool (services/sdk-setup.ts, pinned by
  // discovery-wiring.test.ts). The proved bound belongs to the caller that
  // decides spentness, in services/onchain-note-index.ts.
  test('an all-empty snapshot still yields its advertised cursor, by design', () => {
    const empty = { snapshotBlockNumber: '1000', deposits: [], transacts: [], ragequits: [] };
    expect(snapshotCursor(empty, ['deposits', 'transacts', 'ragequits'])).toBe(1000n);
    expect(newestSnapshotRowBlock(empty)).toBeNull();
  });
});

describe('noteEventsFromSnapshot (discovery reads Note events from the held snapshot)', () => {
  const row = {
    txHash: '0xa45c56491a6a66eb0461ec67caf9a90cad622313ab7fcd5d30044f11957ee22d',
    logIndex: 690,
    hint: '0x01',
    ephemeralPubKey: '0xaa',
    encryptedPayload: '0xbb',
    blockNumber: '26141294',
    blockTimestamp: null,
  };

  test("rows take the SDK's Note-event shape: hex block numbers, no extra fields", () => {
    expect(noteEventsFromSnapshot([row])).toEqual([{
      blockNumber: `0x${(26141294).toString(16)}`,
      txHash: row.txHash,
      hint: '0x01',
      ephemeralPubKey: '0xaa',
      encryptedPayload: '0xbb',
    }]);
  });

  test('an empty ciphertext is dropped, as the HTTP reader drops it', () => {
    expect(noteEventsFromSnapshot([{ ...row, encryptedPayload: '0x' }, { ...row, encryptedPayload: '' }])).toEqual([]);
  });

  test('a malformed row fails the whole read, so discovery scans the chain instead of skipping a note', () => {
    expect(() => noteEventsFromSnapshot([row, { ...row, hint: 'nope' }])).toThrow();
    expect(() => noteEventsFromSnapshot([{ ...row, blockNumber: null }])).toThrow();
    expect(() => noteEventsFromSnapshot(undefined)).toThrow();
  });
});
