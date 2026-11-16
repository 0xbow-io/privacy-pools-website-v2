import { transferFeeBudget } from '@/services/relayer-fee-jitter';
import { expect, test } from 'bun:test';
import type { Note } from '@/services/sdk-types';
import { maxStellarAmount, selectStellarInputs, selectStellarTransferForRelay } from '@/services/stellar-fee-selection';

const note = (value: bigint, label = 'a', id = 1) => ({ value: String(value), label, commitment: `0x${id}`, tokenId: 'XLM' }) as unknown as Note;
const feeFor = (count: number) => count >= 1 && count <= 5 ? BigInt(count) * 1_000_000n : null;

test('fees above 0.075 XLM select sufficient inputs including the shared allowance', () => {
  const selected = selectStellarInputs([note(11_000_000n), note(3_000_000n, 'a', 2)], 10_000_000n, feeFor);
  expect(selected.covered).toBe(true);
  expect(selected.selectedNotes).toHaveLength(2);
  expect(selected.fee).toBe(2_000_000n);
  expect(selected.accumulated).toBeGreaterThanOrEqual(10_000_000n + transferFeeBudget(selected.fee!));
});

test('Max and selection agree at the boundary across shape changes and lineage limits', () => {
  const notes = [note(10_000_000n), note(3_000_000n, 'b', 2), note(2_000_000n, 'c', 3)];
  for (const withdrawal of [false, true]) {
    const fee = (count: number, amount: bigint) => {
      const base = feeFor(count);
      return base === null ? null : base + (withdrawal ? amount / 200n : 0n);
    };
    const max = maxStellarAmount(notes, fee, withdrawal);
    expect(selectStellarInputs(notes, max, fee, withdrawal).covered).toBe(true);
    expect(selectStellarInputs(notes, max + 1n, fee, withdrawal).covered).toBe(false);
  }
});

test('Max does not spend dust whose extra shape fee exceeds its value', () => {
  const notes = [note(10_000_000n), note(100n, 'a', 2)];
  expect(maxStellarAmount(notes, feeFor)).toBe(10_000_000n - transferFeeBudget(1_000_000n));
});

test('unavailable pricing cannot fund a transfer or offer a spendable Max', () => {
  const notes = [note(10_000_000n)];
  expect(selectStellarInputs(notes, 1n, () => null).covered).toBe(false);
  expect(maxStellarAmount(notes, () => null)).toBe(0n);
});

test('withdrawal Max can skip small notes when their extra fee would make consolidation unaffordable', () => {
  const notes = [note(10_000_000n), note(500_000n, 'a', 2)];
  const max = maxStellarAmount(notes, feeFor, true);
  const selected = selectStellarInputs(notes, max, feeFor, true);
  expect(selected.covered).toBe(true);
  expect(selected.selectedNotes).toHaveLength(1);
  expect(selectStellarInputs(notes, max + 1n, feeFor, true).covered).toBe(false);
});


test('Confirm selects against a fresh quote, falling back to its unpadded fee when funds are tight', async () => {
  const notes = [note(12_849_562n)];
  const pick = await selectStellarTransferForRelay(notes, 10_000_000n, async () => 2_849_562n);
  expect(pick.covered).toBe(true);
  expect(pick.accumulated).toBe(12_849_562n);
  expect((await selectStellarTransferForRelay(notes, 10_000_001n, async () => 2_849_562n)).covered).toBe(false);
});


test('a cheaper shape can fund a transfer when the preferred single-lineage shape cannot', async () => {
  const notes = [1, 2, 3, 4].map(id => note(2500000n, 'a', id));
  notes.push(note(7000000n, 'b', 5), note(7000000n, 'c', 6));
  const pick = await selectStellarTransferForRelay(notes, 10000000n, async count => BigInt(count) * 2000000n);
  expect(pick.covered).toBe(true);
  expect(pick.selectedNotes).toHaveLength(2);
});


test('adding a lineage still chooses the smaller fundable proof shape', async () => {
  const notes = [1, 2, 3, 4].map(id => note(2500000n, 'a', id));
  notes.push(note(6000000n, 'b', 5), note(6000000n, 'c', 6));
  const pick = await selectStellarTransferForRelay(notes, 10000000n, async count => BigInt(count) * 1000000n);
  expect(pick.covered).toBe(true);
  expect(pick.selectedNotes).toHaveLength(2);
});

test('the preferred lineage stays private without requesting unused shapes', async () => {
  const notes = [1, 2, 3, 4].map(id => note(3000000n, 'a', id));
  notes.push(note(7000000n, 'b', 5), note(7000000n, 'c', 6));
  const counts: number[] = [];
  const pick = await selectStellarTransferForRelay(notes, 10000000n, async count => { counts.push(count); return 100000n; });
  expect(new Set(pick.selectedNotes.map(n => n.label)).size).toBe(1);
  expect(counts).toEqual([4]);
});
