import { describe, expect, test } from 'bun:test';

import {
  TRANSFER_MAX_INPUTS,
  TRANSFER_MAX_LABELS,
  maxCoverableTransfer,
  selectGreedyTransferInputs,
  topNValueSum,
} from '@/services/transfer-note-selection';
import type { Note } from '@/services/sdk-types';

// Minimal Note fixture: the selectors only read `value` and `label`. `value`
// accepts plain decimal strings here for readability; the real Note types it
// as a `0x${string}`, and BigInt() parses both decimal and hex, so the cast
// through unknown is safe.
function note(value: string, extra: Partial<Note> = {}): Note {
  return { value, tokenId: '0xtoken', ...extra } as unknown as Note;
}

const labeled = (value: string, label: string) => note(value, { label } as Partial<Note>);

describe('selectGreedyTransferInputs', () => {
  test('picks largest notes first and reports coverage once the target is met', () => {
    const notes = [note('20'), note('50'), note('30'), note('10')];
    const r = selectGreedyTransferInputs(notes, 60n);
    // Largest-first: 50 + 30 = 80 >= 60, stop.
    expect(r.selectedNotes.map((n) => n.value)).toEqual(['50', '30']);
    expect(r.accumulated).toBe(80n);
    expect(r.covered).toBe(true);
  });

  test('never selects more than maxInputs, reporting not-covered if the cap is hit first', () => {
    const notes = [note('10'), note('10'), note('10'), note('10'), note('10')];
    const r = selectGreedyTransferInputs(notes, 50n, 3);
    expect(r.selectedNotes).toHaveLength(3);
    expect(r.accumulated).toBe(30n);
    expect(r.covered).toBe(false);
  });

  test('defaults the cap to TRANSFER_MAX_INPUTS', () => {
    expect(TRANSFER_MAX_INPUTS).toBe(5);
    const notes = Array.from({ length: TRANSFER_MAX_INPUTS + 3 }, () => note('1'));
    const r = selectGreedyTransferInputs(notes, 999n);
    expect(r.selectedNotes).toHaveLength(TRANSFER_MAX_INPUTS);
  });

  test('exact coverage stops as soon as the target is reached', () => {
    const notes = [note('40'), note('60'), note('100')];
    const r = selectGreedyTransferInputs(notes, 100n);
    expect(r.selectedNotes.map((n) => n.value)).toEqual(['100']);
    expect(r.covered).toBe(true);
  });

  test('a zero target is covered by selecting nothing', () => {
    const r = selectGreedyTransferInputs([note('10')], 0n);
    expect(r.selectedNotes).toEqual([]);
    expect(r.covered).toBe(true);
  });

  test('an empty note set never covers a positive target', () => {
    const r = selectGreedyTransferInputs([], 1n);
    expect(r.selectedNotes).toEqual([]);
    expect(r.covered).toBe(false);
  });

  test('does not mutate the caller-supplied note array', () => {
    const notes = [note('20'), note('50'), note('30')];
    const before = notes.map((n) => n.value);
    selectGreedyTransferInputs(notes, 40n);
    expect(notes.map((n) => n.value)).toEqual(before);
  });

  test('parses hex-encoded note values the way the real Note type stores them', () => {
    const notes = [note('0x64'), note('0x0a')]; // 100, 10
    const r = selectGreedyTransferInputs(notes, 90n);
    expect(r.selectedNotes.map((n) => n.value)).toEqual(['0x64']);
    expect(r.covered).toBe(true);
  });

  // Single-lineage preference: the transact emits one change note per label
  // (plus up to one recipient note per label) with a 5-output circuit cap, so
  // covering within one label keeps dimensions minimal and links only the
  // lineage the amount requires.
  describe('single-lineage preference', () => {
    test('covers within one label even when larger notes exist in other labels', () => {
      const notes = [
        labeled('60', '0xaaa'),
        labeled('50', '0xbbb'),
        labeled('45', '0xbbb'),
      ];
      // Label-blind largest-first would take 60 (aaa) + 50 (bbb) — two labels.
      // Label bbb alone covers: 50 + 45 = 95 >= 90.
      const r = selectGreedyTransferInputs(notes, 90n);
      expect(r.covered).toBe(true);
      expect(new Set(r.selectedNotes.map((n) => (n as { label: string }).label))).toEqual(new Set(['0xbbb']));
    });

    test('among covering lineages, picks the one needing the fewest notes', () => {
      const notes = [
        labeled('30', '0xmany'),
        labeled('30', '0xmany'),
        labeled('30', '0xmany'),
        labeled('80', '0xone'),
      ];
      const r = selectGreedyTransferInputs(notes, 75n);
      expect(r.covered).toBe(true);
      expect(r.selectedNotes.map((n) => n.value)).toEqual(['80']);
    });

    test('falls back to cross-label selection when no single lineage covers', () => {
      const notes = [
        labeled('40', '0xaaa'),
        labeled('35', '0xbbb'),
      ];
      const r = selectGreedyTransferInputs(notes, 70n);
      expect(r.covered).toBe(true);
      expect(r.accumulated).toBe(75n);
      expect(r.selectedNotes).toHaveLength(2);
    });

    test('single-lineage coverage still respects the input cap', () => {
      const notes = [
        labeled('10', '0xaaa'),
        labeled('10', '0xaaa'),
        labeled('10', '0xaaa'),
        labeled('25', '0xbbb'),
      ];
      // Label aaa would need 3 notes under a cap of 2 — not coverable; bbb
      // covers alone within the cap.
      const r = selectGreedyTransferInputs(notes, 22n, 2);
      expect(r.covered).toBe(true);
      expect(r.selectedNotes.map((n) => n.value)).toEqual(['25']);
    });
  });

  // Exactness: a label-blind greedy fallback can lock into one lineage and miss
  // a fundable pair. The tiered exact search must not.
  describe('exact cross-lineage search', () => {
    test('finds a coverable lineage pair a greedy first-pick would miss', () => {
      const notes = [
        labeled('8', '0xa'),
        labeled('1', '0xa'),
        labeled('1', '0xa'),
        labeled('7', '0xb'),
        labeled('7', '0xb'),
        labeled('7', '0xc'),
        labeled('7', '0xc'),
      ];
      // Largest-first grabs 8(a), locking labels {a,b}, and dies at 24 within 5
      // inputs. B+C = 7+7+7+7 = 28 covers exactly across two lineages.
      const r = selectGreedyTransferInputs(notes, 28n, TRANSFER_MAX_INPUTS, 2);
      expect(r.covered).toBe(true);
      expect(r.accumulated).toBe(28n);
      expect(new Set(r.selectedNotes.map((n) => (n as { label: string }).label))).toEqual(new Set(['0xb', '0xc']));
    });

    test('reports the exact maximum coverable as the shortfall figure', () => {
      const notes = [
        labeled('8', '0xa'),
        labeled('7', '0xb'),
        labeled('7', '0xb'),
        labeled('7', '0xc'),
        labeled('7', '0xc'),
      ];
      // No two lineages reach 30; the best pair (b+c) tops out at 28 — the
      // figure the shortfall message must show, not a greedy understatement.
      const r = selectGreedyTransferInputs(notes, 30n, TRANSFER_MAX_INPUTS, 2);
      expect(r.covered).toBe(false);
      expect(r.accumulated).toBe(28n);
    });

    test('never spans more labels than maxLabels even when that forfeits coverage', () => {
      const notes = [
        labeled('10', '0xa'),
        labeled('10', '0xb'),
        labeled('10', '0xc'),
      ];
      const r = selectGreedyTransferInputs(notes, 30n, TRANSFER_MAX_INPUTS, 2);
      expect(r.covered).toBe(false);
      expect(new Set(r.selectedNotes.map((n) => (n as { label: string }).label)).size).toBeLessThanOrEqual(2);
      expect(r.accumulated).toBe(20n);
    });
  });
});

describe('maxCoverableTransfer', () => {
  test('respects the lineage cap (does not just sum the top-N)', () => {
    const notes = [
      labeled('8', '0xa'),
      labeled('7', '0xb'), labeled('7', '0xb'),
      labeled('7', '0xc'), labeled('7', '0xc'),
    ];
    // Bare top-5 = 8+7+7+7+7 = 36, but only two lineages fit: best pair b+c = 28.
    expect(maxCoverableTransfer(notes, TRANSFER_MAX_INPUTS, 2)).toBe(28n);
    expect(topNValueSum(notes, TRANSFER_MAX_INPUTS)).toBe(36n);
  });

  test('an unbounded lineage cap equals the plain top-N sum', () => {
    const notes = [labeled('8', '0xa'), labeled('7', '0xb'), labeled('7', '0xc')];
    expect(maxCoverableTransfer(notes, TRANSFER_MAX_INPUTS, Number.POSITIVE_INFINITY)).toBe(22n);
  });

  test('defaults the lineage cap to TRANSFER_MAX_LABELS', () => {
    expect(TRANSFER_MAX_LABELS).toBe(2);
    const notes = [labeled('5', '0xa'), labeled('5', '0xb'), labeled('5', '0xc')];
    // Two lineages of 5 → 10 (the default cap), not 15.
    expect(maxCoverableTransfer(notes, TRANSFER_MAX_INPUTS)).toBe(10n);
  });

  test('agrees with the selection: an amount at the ceiling is coverable', () => {
    const notes = [
      labeled('8', '0xa'), labeled('3', '0xa'),
      labeled('7', '0xb'), labeled('7', '0xb'),
      labeled('9', '0xc'),
    ];
    const ceiling = maxCoverableTransfer(notes, TRANSFER_MAX_INPUTS, 2);
    const r = selectGreedyTransferInputs(notes, ceiling, TRANSFER_MAX_INPUTS, 2);
    expect(r.covered).toBe(true);
    // ...and one unit above the ceiling is not.
    const above = selectGreedyTransferInputs(notes, ceiling + 1n, TRANSFER_MAX_INPUTS, 2);
    expect(above.covered).toBe(false);
  });

  test('an empty note set has zero coverable', () => {
    expect(maxCoverableTransfer([], TRANSFER_MAX_INPUTS, 2)).toBe(0n);
  });
});

describe('topNValueSum', () => {
  test('sums the largest maxInputs values, ignoring the rest', () => {
    const notes = [note('10'), note('50'), note('30'), note('20'), note('40')];
    expect(topNValueSum(notes, 3)).toBe(120n);
  });

  test('sums every note when maxInputs exceeds the note count', () => {
    expect(topNValueSum([note('10'), note('20')], 5)).toBe(30n);
  });

  test('an empty note set sums to zero', () => {
    expect(topNValueSum([], 5)).toBe(0n);
  });

  test('does not mutate the caller-supplied note array', () => {
    const notes = [note('20'), note('50'), note('30')];
    const before = notes.map((n) => n.value);
    topNValueSum(notes, 2);
    expect(notes.map((n) => n.value)).toEqual(before);
  });
});

// HIGH-2 (codex): the combos guard must never abandon the lineage cap. With 92
// one-unit notes in 92 distinct labels, choose(92, 2) = 4186 > 4096 trips the
// guard; the old fallback returned an unconstrained top-5 spanning 5 labels and
// claimed target 3 "covered" with max 5. The truth under maxLabels=2 is 2.
describe('combos-guard boundary (bounded DP)', () => {
  const manyLabels = (count: number) =>
    Array.from({ length: count }, (_, i) => labeled('1', `0xlabel${i}`));

  test('92 labels: ceiling respects the 2-lineage cap (DP path)', () => {
    const notes = manyLabels(92);
    expect(maxCoverableTransfer(notes, TRANSFER_MAX_INPUTS, 2)).toBe(2n);
  });

  test('92 labels: selection never spans more than 2 lineages nor over-claims coverage', () => {
    const notes = manyLabels(92);
    const covered = selectGreedyTransferInputs(notes, 2n, TRANSFER_MAX_INPUTS, 2);
    expect(covered.covered).toBe(true);
    expect(new Set(covered.selectedNotes.map((n) => (n as { label: string }).label)).size).toBeLessThanOrEqual(2);

    const over = selectGreedyTransferInputs(notes, 3n, TRANSFER_MAX_INPUTS, 2);
    expect(over.covered).toBe(false);
    expect(over.accumulated).toBe(2n);
    expect(new Set(over.selectedNotes.map((n) => (n as { label: string }).label)).size).toBeLessThanOrEqual(2);
  });

  test('91 labels: enumeration path agrees with the cap (below the guard)', () => {
    const notes = manyLabels(91);
    expect(maxCoverableTransfer(notes, TRANSFER_MAX_INPUTS, 2)).toBe(2n);
    const r = selectGreedyTransferInputs(notes, 3n, TRANSFER_MAX_INPUTS, 2);
    expect(r.covered).toBe(false);
    expect(r.accumulated).toBe(2n);
  });

  test('DP path still finds a rich uneven pair among many lineages', () => {
    // 100 dust lineages plus two rich ones; the capped optimum is the rich pair.
    const notes = [
      ...Array.from({ length: 100 }, (_, i) => labeled('1', `0xdust${i}`)),
      labeled('10', '0xrichA'), labeled('4', '0xrichA'),
      labeled('9', '0xrichB'), labeled('8', '0xrichB'), labeled('2', '0xrichB'),
    ];
    expect(maxCoverableTransfer(notes, TRANSFER_MAX_INPUTS, 2)).toBe(33n); // 10+4 + 9+8+2
    const r = selectGreedyTransferInputs(notes, 33n, TRANSFER_MAX_INPUTS, 2);
    expect(r.covered).toBe(true);
    expect(r.accumulated).toBe(33n);
    expect(new Set(r.selectedNotes.map((n) => (n as { label: string }).label))).toEqual(new Set(['0xrichA', '0xrichB']));
  });
});

describe('selectGreedyTransferInputs with sweepSelectedLabels', () => {
  const sweep = { sweepSelectedLabels: true };
  const labelsOf = (notes: Note[]) => new Set(notes.map((n) => (n as { label: string }).label));

  test('adds only notes of the selected deposit, smallest first, after the covering pick', () => {
    const notes = [
      labeled('100', '0xa'),
      labeled('3', '0xa'),
      labeled('1', '0xa'),
      labeled('2', '0xa'),
      labeled('50', '0xb'),
    ];
    const r = selectGreedyTransferInputs(notes, 60n, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS, sweep);
    expect(r.selectedNotes.map((n) => n.value)).toEqual(['100', '1', '2', '3']);
    expect(labelsOf(r.selectedNotes)).toEqual(new Set(['0xa']));
  });

  test('never exceeds maxInputs, keeping the smallest spare notes', () => {
    const notes = [
      labeled('100', '0xa'),
      ...['7', '6', '5', '4', '3', '2', '1'].map((v) => labeled(v, '0xa')),
    ];
    const r = selectGreedyTransferInputs(notes, 60n, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS, sweep);
    expect(r.selectedNotes).toHaveLength(TRANSFER_MAX_INPUTS);
    expect(r.selectedNotes.map((n) => n.value)).toEqual(['100', '1', '2', '3', '4']);
  });

  test('never adds a third deposit to a two-deposit selection', () => {
    const notes = [
      labeled('10', '0xa'),
      labeled('1', '0xa'),
      labeled('10', '0xb'),
      labeled('1', '0xb'),
      labeled('1', '0xc'),
      labeled('1', '0xc'),
    ];
    const r = selectGreedyTransferInputs(notes, 20n, TRANSFER_MAX_INPUTS, 2, sweep);
    expect(labelsOf(r.selectedNotes)).toEqual(new Set(['0xa', '0xb']));
    expect(r.selectedNotes).toHaveLength(4);
  });

  test('never adds a second deposit when maxLabels is 1', () => {
    const notes = [labeled('10', '0xa'), labeled('1', '0xa'), labeled('1', '0xb'), labeled('1', '0xb')];
    const r = selectGreedyTransferInputs(notes, 5n, TRANSFER_MAX_INPUTS, 1, sweep);
    expect(labelsOf(r.selectedNotes)).toEqual(new Set(['0xa']));
    expect(r.selectedNotes.map((n) => n.value)).toEqual(['10', '1']);
  });

  test('is a no-op unless opted in', () => {
    const notes = [labeled('100', '0xa'), labeled('1', '0xa'), labeled('2', '0xa')];
    const plain = selectGreedyTransferInputs(notes, 60n, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS);
    expect(plain.selectedNotes.map((n) => n.value)).toEqual(['100']);
    expect(plain.accumulated).toBe(100n);
  });

  test('leaves covered describing the target and reports the swept sum as accumulated', () => {
    const notes = [labeled('100', '0xa'), labeled('1', '0xa'), labeled('2', '0xa')];
    const r = selectGreedyTransferInputs(notes, 60n, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS, sweep);
    expect(r.covered).toBe(true);
    expect(r.accumulated).toBe(103n);
    expect(r.accumulated).toBe(r.selectedNotes.reduce((sum, n) => sum + BigInt(n.value), 0n));
  });

  test('skips zero-value notes', () => {
    const notes = [labeled('100', '0xa'), labeled('0', '0xa'), labeled('1', '0xa')];
    const r = selectGreedyTransferInputs(notes, 60n, TRANSFER_MAX_INPUTS, TRANSFER_MAX_LABELS, sweep);
    expect(r.selectedNotes.map((n) => n.value)).toEqual(['100', '1']);
  });
});
