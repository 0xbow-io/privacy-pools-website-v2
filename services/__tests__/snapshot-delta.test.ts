import { describe, expect, test } from 'bun:test';
import { mergeSnapshotDelta, snapshotDeltaSince } from '@/services/snapshot-delta';
import { LOG_SCAN_ALIGNMENT_BLOCKS } from '@/services/log-scan-alignment';

const SECTIONS = ['deposits', 'notes'] as const;
const row = (txHash: string, logIndex: number, blockNumber: string, extra: Record<string, unknown> = {}) =>
  ({ txHash, logIndex, blockNumber, ...extra });

describe('snapshotDeltaSince', () => {
  test('a grid point minus one: the exclusive bound the leaf fast path also sends', () => {
    const since = snapshotDeltaSince(26_176_308n, 0n, 12_000);
    expect((since + 1n) % LOG_SCAN_ALIGNMENT_BLOCKS).toBe(0n);
  });

  test('re-reads at least one grid step behind the last covered block', () => {
    // Mainnet: a day is 7200 blocks, under one grid, so the grid is the floor.
    expect(26_176_308n - snapshotDeltaSince(26_176_308n, 0n, 12_000)).toBeGreaterThanOrEqual(LOG_SCAN_ALIGNMENT_BLOCKS);
  });

  test('and at least a day of blocks on a fast chain', () => {
    // BNB at 750ms: a day is 115200 blocks, far more than one grid.
    const coveredTo = 64_000_000n;
    expect(coveredTo - snapshotDeltaSince(coveredTo, 0n, 750)).toBeGreaterThanOrEqual(115_200n);
  });

  test('never reaches below the deployment block, and so cannot go negative', () => {
    expect(snapshotDeltaSince(25_895_000n, 25_893_288n, 12_000)).toBe(25_893_287n);
    expect(snapshotDeltaSince(5n, 0n, 12_000)).toBe(0n);
  });

  test('clients a few blocks apart send the same value', () => {
    expect(snapshotDeltaSince(26_176_308n, 0n, 12_000)).toBe(snapshotDeltaSince(26_176_390n, 0n, 12_000));
  });
});

describe('mergeSnapshotDelta', () => {
  const base = {
    chainId: '1',
    snapshotBlockNumber: '200',
    generatedAt: 'then',
    deposits: [row('0xa', 1, '50'), row('0xb', 2, '150'), row('0xc', 3, '190')],
    notes: [row('0xa', 0, '50'), row('0xc', 4, '190')],
  };

  test("rows at or below `since` stay; everything above it is the delta's, with the delta's envelope", () => {
    const delta = {
      chainId: '1', snapshotBlockNumber: '300', generatedAt: 'now',
      deposits: [row('0xb', 2, '150'), row('0xd', 5, '260')],
      notes: [row('0xd', 6, '260')],
    };
    const merged = mergeSnapshotDelta(base, delta, 100n, SECTIONS)!;
    expect(merged.snapshotBlockNumber).toBe('300');
    expect(merged.generatedAt).toBe('now');
    expect(merged.deposits.map((r) => r.txHash)).toEqual(['0xa', '0xb', '0xd']);
    expect(merged.notes.map((r) => r.txHash)).toEqual(['0xa', '0xd']);
  });

  test('a row indexed late, after the last refresh, appears', () => {
    const delta = { ...base, snapshotBlockNumber: '300', deposits: [row('0xb', 2, '150'), row('0xlate', 9, '120'), row('0xc', 3, '190')], notes: base.notes.slice(1) };
    expect(mergeSnapshotDelta(base, delta, 100n, SECTIONS)!.deposits.map((r) => r.txHash)).toEqual(['0xa', '0xb', '0xlate', '0xc']);
  });

  test('a row the ASP no longer serves above `since` disappears', () => {
    const delta = { ...base, deposits: [row('0xb', 2, '150')], notes: [] };
    const merged = mergeSnapshotDelta(base, delta, 100n, SECTIONS)!;
    expect(merged.deposits.map((r) => r.txHash)).toEqual(['0xa', '0xb']);
    expect(merged.notes.map((r) => r.txHash)).toEqual(['0xa']);
  });

  test('a server that ignores `since` still yields each row once, the delta copy winning', () => {
    const delta = { ...base, deposits: [row('0xa', 1, '50', { fresh: true }), ...base.deposits.slice(1)] };
    const merged = mergeSnapshotDelta(base, delta, 100n, SECTIONS)!;
    expect(merged.deposits).toHaveLength(3);
    expect(merged.deposits[0]).toEqual(row('0xa', 1, '50', { fresh: true }));
  });

  test('refuses what it cannot join safely, so the caller downloads in full', () => {
    expect(mergeSnapshotDelta(base, { ...base, chainId: '56' }, 100n, SECTIONS)).toBeNull();
    expect(mergeSnapshotDelta(base, { ...base, notes: undefined as unknown as [] }, 100n, SECTIONS)).toBeNull();
    expect(mergeSnapshotDelta({ ...base, deposits: [row('0xa', 1, 'garbage')] }, base, 100n, SECTIONS)).toBeNull();
  });
});
