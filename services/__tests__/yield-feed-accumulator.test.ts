import { describe, expect, test } from 'bun:test';

import {
  compareIds,
  cursorWasInvalidated,
  mayResume,
  EMPTY_YIELD_FEED_ACCUMULATOR,
  mergeYieldFeedRows,
  resumePoint,
  type YieldFeedAccumulator,
} from '@/services/yield-feed-accumulator';

type Row = { id: string; v: number };
const idOf = (r: Row) => r.id;
const rows = (...ids: number[]): Row[] => ids.map((n) => ({ id: String(n), v: n }));

function empty(): YieldFeedAccumulator<Row> {
  return EMPTY_YIELD_FEED_ACCUMULATOR as YieldFeedAccumulator<Row>;
}

describe('mergeYieldFeedRows', () => {
  test('a bootstrap keeps every row and takes the cursor', () => {
    const merged = mergeYieldFeedRows({ prev: empty(), incoming: rows(1, 2, 3), lastSyncedId: '3', idOf });
    expect(merged.rows.map(idOf)).toEqual(['1', '2', '3']);
    expect(merged.lastSyncedId).toBe('3');
  });

  test('an increment appends without refetching what we hold', () => {
    const boot = mergeYieldFeedRows({ prev: empty(), incoming: rows(1, 2, 3), lastSyncedId: '3', idOf });
    const next = mergeYieldFeedRows({ prev: boot, incoming: rows(4, 5), lastSyncedId: '5', idOf });
    expect(next.rows.map(idOf)).toEqual(['1', '2', '3', '4', '5']);
    expect(next.lastSyncedId).toBe('5');
  });

  // The property that protects the money: two DIFFERENT overlap shapes must
  // both leave one row per id. A duplicated deposit row is a wrong earned
  // figure, not a cosmetic glitch.
  test('an overlapping resend never double-counts, whatever the overlap', () => {
    const boot = mergeYieldFeedRows({ prev: empty(), incoming: rows(1, 2, 3), lastSyncedId: '3', idOf });

    const fullReplay = mergeYieldFeedRows({ prev: boot, incoming: rows(1, 2, 3), lastSyncedId: '3', idOf });
    expect(fullReplay.rows.map(idOf)).toEqual(['1', '2', '3']);

    const partialOverlap = mergeYieldFeedRows({ prev: boot, incoming: rows(3, 4), lastSyncedId: '4', idOf });
    expect(partialOverlap.rows.map(idOf)).toEqual(['1', '2', '3', '4']);
  });

  test('a re-served row is replaced by the incoming copy, not kept stale', () => {
    const boot = mergeYieldFeedRows({ prev: empty(), incoming: [{ id: '1', v: 10 }], lastSyncedId: '1', idOf });
    const corrected = mergeYieldFeedRows({ prev: boot, incoming: [{ id: '1', v: 99 }], lastSyncedId: '1', idOf });
    expect(corrected.rows).toEqual([{ id: '1', v: 99 }]);
  });

  test('rows come back ascending even when the server pages them out of order', () => {
    const merged = mergeYieldFeedRows({ prev: empty(), incoming: rows(3, 1, 2), lastSyncedId: '3', idOf });
    expect(merged.rows.map(idOf)).toEqual(['1', '2', '3']);
  });

  test('ids sort numerically, so 10 follows 9 instead of preceding it', () => {
    const merged = mergeYieldFeedRows({ prev: empty(), incoming: rows(9, 10, 11), lastSyncedId: '11', idOf });
    expect(merged.rows.map(idOf)).toEqual(['9', '10', '11']);
    expect(compareIds('10', '9')).toBeGreaterThan(0);
  });

  // A quiet tick must not send the next one back to a full bootstrap.
  test('the cursor never goes backwards', () => {
    const boot = mergeYieldFeedRows({ prev: empty(), incoming: rows(1, 2, 3), lastSyncedId: '3', idOf });

    const quiet = mergeYieldFeedRows({ prev: boot, incoming: [], lastSyncedId: null, idOf });
    expect(quiet.lastSyncedId).toBe('3');
    expect(quiet.rows.map(idOf)).toEqual(['1', '2', '3']);

    const regressed = mergeYieldFeedRows({ prev: boot, incoming: [], lastSyncedId: '1', idOf });
    expect(regressed.lastSyncedId).toBe('3');

    const blank = mergeYieldFeedRows({ prev: boot, incoming: [], lastSyncedId: '', idOf });
    expect(blank.lastSyncedId).toBe('3');
  });

  test('retention drops the OLDEST rows, keeping the recent history consumers read', () => {
    const boot = mergeYieldFeedRows({ prev: empty(), incoming: rows(1, 2, 3, 4), lastSyncedId: '4', idOf, maxRows: 2 });
    expect(boot.rows.map(idOf)).toEqual(['3', '4']);

    const next = mergeYieldFeedRows({ prev: boot, incoming: rows(5), lastSyncedId: '5', idOf, maxRows: 2 });
    expect(next.rows.map(idOf)).toEqual(['4', '5']);
    // Trimming history must not rewind the resume point.
    expect(next.lastSyncedId).toBe('5');
  });

  test('the shared empty accumulator is never mutated by a merge', () => {
    mergeYieldFeedRows({ prev: empty(), incoming: rows(1), lastSyncedId: '1', idOf });
    expect(EMPTY_YIELD_FEED_ACCUMULATOR.rows).toHaveLength(0);
    expect(EMPTY_YIELD_FEED_ACCUMULATOR.lastSyncedId).toBeNull();
  });
});

describe('mayResume — the cursor may only cross a gap the grid itself makes', () => {
  const INTERVAL = 600_000;

  test('a fresh accumulator bootstraps', () => {
    expect(mayResume({ syncedAt: null, now: 1_000_000, intervalMs: INTERVAL })).toBe(false);
  });

  test('the previous tick, and a late one, still resume', () => {
    expect(mayResume({ syncedAt: 1_000_000, now: 1_600_000, intervalMs: INTERVAL })).toBe(true);
    expect(mayResume({ syncedAt: 1_000_000, now: 2_200_000, intervalMs: INTERVAL })).toBe(true);
  });

  // The whole point: a throttled tab, a sleeping laptop or an offline spell
  // would otherwise send a cursor no other client sends, dating this client's
  // last successful tick and linking its sessions across the gap.
  test('a client that missed ticks bootstraps instead of sending a stale cursor', () => {
    expect(mayResume({ syncedAt: 1_000_000, now: 1_000_000 + 6 * INTERVAL, intervalMs: INTERVAL })).toBe(false);
  });

  test('a clock that stepped backwards is not evidence of a recent tick', () => {
    expect(mayResume({ syncedAt: 2_000_000, now: 1_000_000, intervalMs: INTERVAL })).toBe(false);
  });
});

describe('a truncated drain', () => {
  test('still merges its prefix and advances, so the next tick continues', () => {
    const partial = mergeYieldFeedRows({
      prev: empty(), incoming: rows(1, 2, 3), lastSyncedId: '3', idOf, complete: false, now: 500,
    });
    expect(partial.rows.map(idOf)).toEqual(['1', '2', '3']);
    expect(partial.lastSyncedId).toBe('3');
    // Not publishable, and not a sync: the next tick must not think it resumed
    // from a settled state.
    expect(partial.complete).toBe(false);
    expect(partial.syncedAt).toBeNull();

    const finished = mergeYieldFeedRows({
      prev: partial, incoming: rows(4, 5), lastSyncedId: '5', idOf, complete: true, now: 900,
    });
    expect(finished.rows.map(idOf)).toEqual(['1', '2', '3', '4', '5']);
    expect(finished.complete).toBe(true);
    expect(finished.syncedAt).toBe(900);
  });
});

describe('resumePoint — a capped prefix continues under the same rule', () => {
  const INTERVAL = 600_000;

  test('a prefix resumes from its own cursor on the next tick', () => {
    const partial = mergeYieldFeedRows({
      prev: empty(), incoming: rows(1, 2, 3), lastSyncedId: '3', idOf, complete: false, now: 1_000_000,
    });
    expect(resumePoint(partial, 1_000_000 + INTERVAL, INTERVAL)).toBe(partial);
  });

  test('a complete feed resumes the same way', () => {
    const done = mergeYieldFeedRows({ prev: empty(), incoming: rows(1), lastSyncedId: '1', idOf, now: 1_000_000 });
    expect(resumePoint(done, 1_000_000 + INTERVAL, INTERVAL)).toBe(done);
  });

  test('after an extended gap, prefix or not, it bootstraps', () => {
    const partial = mergeYieldFeedRows({
      prev: empty(), incoming: rows(1, 2, 3), lastSyncedId: '3', idOf, complete: false, now: 1_000_000,
    });
    expect(resumePoint(partial, 1_000_000 + 6 * INTERVAL, INTERVAL).lastSyncedId).toBeNull();
    expect(resumePoint(undefined, 1_000_000, INTERVAL).lastSyncedId).toBeNull();
  });
});

describe('a server that reused its row ids', () => {
  type Obs = { id: string; block: string };
  const obsId = (r: Obs) => r.id;
  const obsKey = (r: Obs) => r.block;

  test('is detected when a resumed page serves a row at or below the cursor', () => {
    expect(cursorWasInvalidated({ cursor: '1272', incoming: [{ id: '1', block: 'b1' }], idOf: obsId })).toBe(true);
    expect(cursorWasInvalidated({ cursor: '1272', incoming: [{ id: '1273', block: 'b1' }], idOf: obsId })).toBe(false);
    expect(cursorWasInvalidated({ cursor: null, incoming: [{ id: '1', block: 'b1' }], idOf: obsId })).toBe(false);
  });

  test('the natural key keeps one row per observation when ids are reused', () => {
    const before: YieldFeedAccumulator<Obs> = {
      rows: [{ id: '900', block: 'b1' }, { id: '901', block: 'b2' }], lastSyncedId: '901', complete: true, syncedAt: 1, progressAt: 1,
    };
    // Same two observations re-served under a restarted id sequence.
    const after = mergeYieldFeedRows({
      prev: before,
      incoming: [{ id: '1', block: 'b1' }, { id: '2', block: 'b2' }],
      lastSyncedId: '2', idOf: obsId, keyOf: obsKey, now: 2,
    });
    expect(after.rows).toHaveLength(2);
    expect(after.rows.map(obsKey).sort()).toEqual(['b1', 'b2']);
  });
});

describe('a drain that does not advance ages out instead of resuming forever', () => {
  const idOf = (r: { id: string }) => r.id;
  test('a partial drain that moved the cursor records progress', () => {
    const prev = { rows: [], lastSyncedId: '10', complete: false, syncedAt: null, progressAt: 100 };
    const next = mergeYieldFeedRows({ prev, incoming: [{ id: '11' }], lastSyncedId: '11', idOf, complete: false, now: 200 });
    expect(next.progressAt).toBe(200);
  });
  test('a partial drain that left the cursor where it was keeps the old progress time', () => {
    const prev = { rows: [{ id: '10' }], lastSyncedId: '10', complete: false, syncedAt: null, progressAt: 100 };
    const next = mergeYieldFeedRows({ prev, incoming: [], lastSyncedId: '10', idOf, complete: false, now: 200 });
    expect(next.progressAt).toBe(100);
  });
  test('a cursor that keeps stalling ages out of resumption into a bootstrap', () => {
    const interval = 600_000;
    let acc: YieldFeedAccumulator<{ id: string }> = { rows: [{ id: '10' }], lastSyncedId: '10', complete: false, syncedAt: null, progressAt: 0 };
    // Every tick re-sends the same cursor and gets nothing new.
    for (let tick = 1; tick <= 5; tick++) {
      acc = mergeYieldFeedRows({ prev: resumePoint(acc, tick * interval, interval), incoming: [], lastSyncedId: '10', idOf, complete: false, now: tick * interval });
    }
    // With no progress since t=0, the window has passed: the next tick bootstraps.
    expect(resumePoint(acc, 6 * interval, interval).lastSyncedId).toBeNull();
  });

  test('a capped prefix that keeps advancing keeps resuming', () => {
    const interval = 600_000;
    let acc: YieldFeedAccumulator<{ id: string }> = { rows: [], lastSyncedId: '10', complete: false, syncedAt: null, progressAt: 0 };
    for (let tick = 1; tick <= 5; tick++) {
      const cursor = String(10 + tick);
      acc = mergeYieldFeedRows({ prev: resumePoint(acc, tick * interval, interval), incoming: [{ id: cursor }], lastSyncedId: cursor, idOf, complete: false, now: tick * interval });
    }
    expect(resumePoint(acc, 6 * interval, interval).lastSyncedId).toBe('15');
  });
});
