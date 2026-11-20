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

describe('transferGasUnits (relay_gas_budget.ts, v2-monorepo#539)', () => {
  // Imported lazily so this file still reads as the counts' own test.
  test('one input and the two base outputs is the one-input budget', async () => {
    const { transferGasUnits, SHIELDED_TRANSFER_GAS } = await import('@/services/transfer-fee-estimate');
    expect(transferGasUnits()).toBe(SHIELDED_TRANSFER_GAS);
    expect(transferGasUnits({ inputs: 1, outputs: 2 })).toBe(SHIELDED_TRANSFER_GAS);
  });

  test('each extra input and each output past two adds its budget', async () => {
    const { transferGasUnits, SHIELDED_TRANSFER_GAS, EXTRA_INPUT_GAS, EXTRA_OUTPUT_GAS } = await import('@/services/transfer-fee-estimate');
    expect(transferGasUnits({ inputs: 4, outputs: 2 })).toBe(SHIELDED_TRANSFER_GAS + 3n * EXTRA_INPUT_GAS);
    expect(transferGasUnits({ inputs: 3, outputs: 4 })).toBe(SHIELDED_TRANSFER_GAS + 2n * EXTRA_INPUT_GAS + 2n * EXTRA_OUTPUT_GAS);
  });

  test('a consolidation (amount 0) has no recipient outputs', () => {
    expect(transferQuoteCounts([note('1', 5n), note('1', 5n), note('2', 5n), note('2', 5n)], 0n)).toEqual({ inputs: 4, outputs: 2 });
  });
});
