import { describe, expect, test } from 'bun:test';
import type { Hash, NotePoints, PointsSummary } from '@privacy-pools-v2/sdk';

import {
  aggregatePoints,
  formatCohort,
  formatCountdown,
  formatPoints,
  pointsTotal,
  toPointsNoteInputs,
} from '@/services/points';

const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ONE = 10n ** 18n;

const symbols = new Map([
  [ETH.toLowerCase(), 'ETH'],
  [USDC.toLowerCase(), 'USDC'],
]);

describe('toPointsNoteInputs', () => {
  const base = { tokenId: ETH, value: '0xde0b6b3a7640000', createdAtBlock: '0x68000000' };

  test('maps note status onto ASP status and spent state', () => {
    const inputs = toPointsNoteInputs(
      [
        { ...base, commitment: 'a', status: 'ACTIVE' },
        { ...base, commitment: 'b', status: 'PENDING' },
        { ...base, commitment: 'c', status: 'REJECTED' },
        { ...base, commitment: 'd', status: 'SPENT' },
        { ...base, commitment: 'e', status: 'INACTIVE' },
      ],
      (c) => (c === 'd' ? 1_800_000_000 : null),
    );
    expect(inputs.map((n) => [n.commitment, n.aspStatus, n.spentAt])).toEqual([
      ['a', 'approved', null],
      ['b', 'pending', null],
      ['c', 'declined', null],
      ['d', 'approved', 1_800_000_000n],
    ]);
    expect(inputs[0].value).toBe(ONE);
    expect(inputs[0].createdAt).toBe(0x68000000n);
  });

  test('a spent note with no known spend time is sent as "unknown", never as still held', () => {
    const inputs = toPointsNoteInputs(
      [
        { ...base, commitment: 'x', status: 'SPENT' },
        { ...base, commitment: 'y', status: 'EXITED' },
        { ...base, commitment: 'z', status: 'EXIT_PENDING' },
      ],
      () => null,
    );
    expect(inputs.map((n) => n.spentAt)).toEqual(['unknown', 'unknown', 'unknown']);
  });

  test('an unspent note is sent with spentAt null even if a spend time is recorded', () => {
    const [input] = toPointsNoteInputs([{ ...base, commitment: 'x', status: 'ACTIVE' }], () => 1_800_000_000);
    expect(input.spentAt).toBeNull();
  });

  test('a missing creation time is sent as 0, which the SDK reports as unknown', () => {
    const [input] = toPointsNoteInputs([{ ...base, commitment: 'x', status: 'ACTIVE', createdAtBlock: null }], () => null);
    expect(input.createdAt).toBe(0n);
  });

  test('skips zero and unparsable values', () => {
    const inputs = toPointsNoteInputs(
      [
        { ...base, commitment: 'z', status: 'ACTIVE', value: '0x0' },
        { ...base, commitment: 'q', status: 'ACTIVE', value: 'nope' },
      ],
      () => null,
    );
    expect(inputs).toHaveLength(0);
  });
});

function note(
  partial: Omit<Partial<NotePoints>, 'commitment'> & Pick<NotePoints, 'status'> & { commitment: string },
): NotePoints {
  return {
    tokenId: USDC,
    claimable: 0n,
    pending: 0n,
    estimated: 0n,
    activatesAt: null,
    cohortBps: 60_000,
    pointsPerDay: 0n,
    perEpoch: [],
    ...partial,
    commitment: partial.commitment as Hash,
  };
}

function summary(notes: NotePoints[]): PointsSummary {
  const claimable = notes.reduce((s, n) => s + n.claimable, 0n);
  const pending = notes.reduce((s, n) => s + n.pending, 0n);
  const estimated = notes.reduce((s, n) => s + n.estimated, 0n);
  return {
    claimable,
    pending,
    estimated,
    total: claimable + pending + estimated,
    pointsPerDay: notes.reduce((s, n) => s + n.pointsPerDay, 0n),
    byTokenId: {},
    notes,
  };
}

function chain(chainId: number, notes: NotePoints[], pending: string[] = [], latestEpoch: bigint | null = 1n) {
  return { chainId, summary: summary(notes), symbols, pendingCommitments: new Set(pending), latestEpoch };
}

describe('aggregatePoints', () => {
  test('sums across chains and keeps the same tokenId apart per chain', () => {
    const totals = aggregatePoints([
      chain(1, [note({ commitment: 'a', status: 'accruing', tokenId: ETH, claimable: 5n * ONE, estimated: ONE, pointsPerDay: ONE })]),
      chain(10, [note({ commitment: 'b', status: 'accruing', tokenId: ETH, claimable: 2n * ONE, pointsPerDay: ONE })], [], 3n),
    ]);
    expect(totals.claimable).toBe(7n * ONE);
    expect(totals.estimated).toBe(ONE);
    expect(totals.pointsPerDay).toBe(2n * ONE);
    expect(totals.latestEpoch).toBe(3n);
    expect(totals.rows.map((r) => r.key)).toEqual([`1:${ETH.toLowerCase()}`, `10:${ETH.toLowerCase()}`]);
  });

  test('a row carries the range of its live notes\' cohorts, ignoring closed ones', () => {
    const totals = aggregatePoints([chain(1, [
      note({ commitment: 'a', status: 'accruing', cohortBps: 60_000 }),
      note({ commitment: 'b', status: 'accruing', cohortBps: 20_000 }),
      note({ commitment: 'c', status: 'closed', cohortBps: 10_000, claimable: ONE }),
    ])]);
    expect(totals.rows[0].cohortBps).toEqual({ min: 20_000, max: 60_000 });
    expect(formatCohort(totals.rows[0].cohortBps)).toBe('2×–6×');
  });

  test('a row reads accruing if any note accrues, and keeps the earliest activation', () => {
    const totals = aggregatePoints([chain(1, [
      note({ commitment: 'a', status: 'activating', activatesAt: 300n }),
      note({ commitment: 'b', status: 'accruing', pointsPerDay: ONE }),
      note({ commitment: 'c', status: 'activating', activatesAt: 200n }),
    ])]);
    expect(totals.rows).toHaveLength(1);
    expect(totals.rows[0].status).toBe('accruing');
    expect(totals.rows[0].activatesAt).toBe(200);
  });

  test('counts unknown-time notes apart, drops ineligible, marks pending as under review', () => {
    const totals = aggregatePoints([chain(1, [
      note({ commitment: 'u', status: 'unknown-time' }),
      note({ commitment: 'p', status: 'accruing', pending: ONE }),
      note({ commitment: 'd', status: 'ineligible' }),
    ], ['p'])]);
    expect(totals.unknownTimeCount).toBe(1);
    expect(totals.rows.map((r) => [r.symbol, r.status])).toEqual([['USDC', 'pending-review']]);
  });

  test('pending-review points stay out of claimable at every level', () => {
    const totals = aggregatePoints([
      chain(1, [
        note({ commitment: 'a', status: 'accruing', claimable: 3n * ONE, estimated: ONE }),
        note({ commitment: 'p', status: 'accruing', pending: 2n * ONE, estimated: ONE }),
      ], ['p']),
      chain(10, [note({ commitment: 'q', status: 'closed', tokenId: ETH, pending: 5n * ONE })]),
    ]);
    expect(totals.claimable).toBe(3n * ONE);
    expect(totals.pending).toBe(7n * ONE);
    expect(totals.estimated).toBe(2n * ONE);
    expect(pointsTotal(totals)).toBe(12n * ONE);
    const usdc = totals.rows.find((r) => r.chainId === 1)!;
    expect([usdc.status, usdc.claimable, usdc.pending, usdc.estimated]).toEqual(['accruing', 3n * ONE, 2n * ONE, 2n * ONE]);
    // A closed row that earned only pending points is still shown, and as nothing claimable.
    const eth = totals.rows.find((r) => r.chainId === 10)!;
    expect([eth.status, eth.claimable, eth.pending]).toEqual(['closed', 0n, 5n * ONE]);
  });

  test('a note with pending points reads as under review even without the pending set', () => {
    const totals = aggregatePoints([chain(1, [note({ commitment: 'p', status: 'accruing', pending: ONE })])]);
    expect(totals.rows[0].status).toBe('pending-review');
    expect(totals.claimable).toBe(0n);
  });

  test('drops closed rows that earned nothing', () => {
    expect(aggregatePoints([chain(1, [note({ commitment: 'a', status: 'closed' })])]).rows).toHaveLength(0);
  });
});

describe('formatting', () => {
  test('formatPoints', () => {
    expect(formatPoints(0n)).toBe('0');
    expect(formatPoints(1n)).toBe('<0.01');
    expect(formatPoints(ONE + ONE / 4n)).toBe('1.25');
    expect(formatPoints(138_000n * ONE)).toBe('138,000');
  });

  test('formatCohort', () => {
    expect(formatCohort(null)).toBe('—');
    expect(formatCohort({ min: 60_000, max: 60_000 })).toBe('6×');
    expect(formatCohort({ min: 15_000, max: 15_000 })).toBe('1.5×');
  });

  test('formatCountdown', () => {
    expect(formatCountdown(59 * 60)).toBe('<1h');
    expect(formatCountdown(5 * 3600)).toBe('5h');
    expect(formatCountdown(3 * 86_400 + 4 * 3600)).toBe('3d 4h');
  });
});
