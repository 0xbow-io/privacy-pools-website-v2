import { describe, it, expect } from 'vitest';
import {
  selectSuiNotes,
  maxSuiLineageTotal,
} from '@/services/sui-witness/note-selection';
import type { StoredSuiNote } from '@/services/sui-witness/note-store';

/**
 * Lineage-first, artifact-capped Sui note selection (codex round-1 finding 3 +
 * round-2 finding 5).
 *
 * A Sui transact keeps value conservation per label, so all inputs of a spend
 * must share one lineage — AND only the transact_1x1/1x2 artifacts ship, so a
 * spend can use at most ONE input note (maxInputs defaults to 1). These tests
 * pin both behaviors.
 */

const SUI = 1_000_000_000n; // 9 decimals (MIST)
const LABEL_A = '100';
const LABEL_B = '200';

function note(over: Partial<Omit<StoredSuiNote, 'value'>> & { value: bigint }): StoredSuiNote {
  return {
    commitment: over.commitment ?? `c-${Math.random()}`,
    value: over.value.toString(),
    tokenId: over.tokenId ?? '1111',
    label: over.label ?? LABEL_A,
    noteSecret: '42',
    ownerAddress: '7',
    coinType: '0x2::sui::SUI',
    status: over.status ?? 'active',
    txDigest: over.txDigest,
  };
}

describe('selectSuiNotes (lineage-first, default single-input cap)', () => {
  it('picks the covering lineage instead of mixing (the round-1 finding scenario)', () => {
    // [1 SUI label A, 10 SUI label B], want 5 -> must pick B alone.
    const notes = [
      note({ commitment: 'a1', value: 1n * SUI, label: LABEL_A }),
      note({ commitment: 'b1', value: 10n * SUI, label: LABEL_B }),
    ];
    const sel = selectSuiNotes(notes, 5n * SUI);
    expect(sel).not.toBeNull();
    expect(sel!.notes.map((n) => n.commitment)).toEqual(['b1']);
    expect(sel!.sum).toBe(10n * SUI);
    expect(sel!.label).toBe(BigInt(LABEL_B));
  });

  it('with the default cap of 1, requires a SINGLE note to cover (unshipped multi-input artifacts)', () => {
    // Same lineage 2+2+2 = 6 covers 3, but no single note does -> null.
    const notes = [
      note({ commitment: 'a1', value: 2n * SUI }),
      note({ commitment: 'a2', value: 2n * SUI }),
      note({ commitment: 'a3', value: 2n * SUI }),
    ];
    expect(selectSuiNotes(notes, 3n * SUI)).toBeNull();
    // A single covering note in the lineage is chosen (largest-first).
    const withBig = [...notes, note({ commitment: 'a4', value: 5n * SUI })];
    const sel = selectSuiNotes(withBig, 3n * SUI);
    expect(sel!.notes.map((n) => n.commitment)).toEqual(['a4']);
    expect(sel!.sum).toBe(5n * SUI);
  });

  it('picks the lineage whose single LARGEST note covers, not the first stored note', () => {
    // Storage order has the small note first within the lineage.
    const notes = [
      note({ commitment: 's1', value: 1n * SUI }),
      note({ commitment: 's2', value: 7n * SUI }),
    ];
    const sel = selectSuiNotes(notes, 5n * SUI);
    expect(sel!.notes.map((n) => n.commitment)).toEqual(['s2']);
  });

  it('with maxInputs > 1, greedy-accumulates largest-first within one lineage', () => {
    const notes = [
      note({ commitment: 'a1', value: 2n * SUI }),
      note({ commitment: 'a2', value: 2n * SUI }),
      note({ commitment: 'a3', value: 2n * SUI }),
    ];
    const sel = selectSuiNotes(notes, 3n * SUI, 5);
    expect(sel).not.toBeNull();
    expect(sel!.notes.map((n) => n.commitment)).toEqual(['a1', 'a2']);
    expect(sel!.sum).toBe(4n * SUI);
    expect(sel!.label).toBe(BigInt(LABEL_A));
  });

  it('never mixes lineages even with a higher cap', () => {
    // 3 + 3 = 6 covers 5, but the notes are in different lineages.
    const notes = [
      note({ value: 3n * SUI, label: LABEL_A }),
      note({ value: 3n * SUI, label: LABEL_B }),
    ];
    expect(selectSuiNotes(notes, 5n * SUI, 5)).toBeNull();
  });

  it('ignores spent notes', () => {
    const notes = [
      note({ commitment: 's1', value: 10n * SUI, status: 'spent' }),
      note({ commitment: 'a1', value: 2n * SUI }),
    ];
    expect(selectSuiNotes(notes, 5n * SUI)).toBeNull();
    const sel = selectSuiNotes(notes, 1n * SUI);
    expect(sel!.notes.map((n) => n.commitment)).toEqual(['a1']);
  });

  it('treats the same label under different tokenIds as different lineages', () => {
    const notes = [
      note({ commitment: 't1', value: 3n * SUI, tokenId: '1' }),
      note({ commitment: 't2', value: 3n * SUI, tokenId: '2' }),
    ];
    // Neither (label, tokenId) group alone covers 5 (even with a high cap).
    expect(selectSuiNotes(notes, 5n * SUI, 5)).toBeNull();
    const sel = selectSuiNotes(notes, 3n * SUI);
    expect(sel!.notes.map((n) => n.commitment)).toEqual(['t1']);
  });

  it('returns null for a non-positive amount or cap', () => {
    expect(selectSuiNotes([note({ value: SUI })], 0n)).toBeNull();
    expect(selectSuiNotes([note({ value: SUI })], SUI, 0)).toBeNull();
  });
});

describe('maxSuiLineageTotal (same cap as selection)', () => {
  it('default cap 1: the largest single ACTIVE note value', () => {
    const notes = [
      note({ value: 1n * SUI, label: LABEL_A }),
      note({ value: 4n * SUI, label: LABEL_B }),
      note({ value: 3n * SUI, label: LABEL_B }),
      note({ value: 100n * SUI, label: LABEL_B, status: 'spent' }),
    ];
    expect(maxSuiLineageTotal(notes)).toBe(4n * SUI);
  });

  it('cap N: the largest top-N single-lineage ACTIVE total, never cross-lineage', () => {
    const notes = [
      note({ value: 1n * SUI, label: LABEL_A }),
      note({ value: 4n * SUI, label: LABEL_B }),
      note({ value: 3n * SUI, label: LABEL_B }),
    ];
    expect(maxSuiLineageTotal(notes, 5)).toBe(7n * SUI);
  });

  it('is 0 with no active notes', () => {
    expect(maxSuiLineageTotal([])).toBe(0n);
  });
});
