import { describe, expect, test } from 'bun:test';
import { sameQuoteCounts, transferQuoteCounts, withdrawQuoteCounts } from '@/services/quote-note-counts';

const note = (label: string, value: bigint) => ({ label: `0x${label}` as const, value: `0x${value.toString(16)}` as const });

describe('withdrawQuoteCounts', () => {
  test('one note is one input and one change output', () => {
    expect(withdrawQuoteCounts([note('1', 10n)])).toEqual({ inputs: 1, outputs: 1 });
  });

  test('two notes of one label are two inputs and one output', () => {
    expect(withdrawQuoteCounts([note('1', 10n), note('1', 5n)])).toEqual({ inputs: 2, outputs: 1 });
  });

  test('every distinct label gets its own change note', () => {
    expect(withdrawQuoteCounts([note('1', 10n), note('2', 5n), note('1', 1n)])).toEqual({ inputs: 3, outputs: 2 });
  });
});

describe('transferQuoteCounts', () => {
  test('an amount inside the first label needs one recipient note', () => {
    expect(transferQuoteCounts([note('1', 10n), note('2', 10n)], 4n)).toEqual({ inputs: 2, outputs: 3 });
  });

  test('an amount spilling into the next label needs a recipient note per label', () => {
    expect(transferQuoteCounts([note('1', 10n), note('2', 10n)], 15n)).toEqual({ inputs: 2, outputs: 4 });
  });

  test('a label total is the sum of its notes', () => {
    expect(transferQuoteCounts([note('1', 6n), note('1', 6n), note('2', 10n)], 12n)).toEqual({ inputs: 3, outputs: 3 });
  });

  test('labels are taken in the order the inputs list them', () => {
    expect(transferQuoteCounts([note('2', 3n), note('1', 20n)], 10n)).toEqual({ inputs: 2, outputs: 4 });
  });
});

test('sameQuoteCounts compares both counts', () => {
  expect(sameQuoteCounts({ inputs: 2, outputs: 3 }, { inputs: 2, outputs: 3 })).toBe(true);
  expect(sameQuoteCounts({ inputs: 2, outputs: 3 }, { inputs: 3, outputs: 3 })).toBe(false);
  expect(sameQuoteCounts({ inputs: 2, outputs: 3 }, { inputs: 2, outputs: 2 })).toBe(false);
});
