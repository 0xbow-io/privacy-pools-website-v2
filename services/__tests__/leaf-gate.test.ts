import { describe, expect, test } from 'bun:test';
import {
  normalizeLeafHash,
  confirmSpendableCommitments,
  buildLeafGateNotesKey,
  resolveLeafGateForInputs,
  failedLeafGate,
  isProvablySpendable,
  countsAsSpendableForDisplay,
  LOADING_GATE,
  type LeafGate,
} from '../leaf-gate';

const padded = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}`;
/** Stand-in for the SDK's Poseidon: label -> deterministic number. */
const hashLabel = (label: unknown) => String(BigInt(String(label)) * 7n);

describe('normalizeLeafHash', () => {
  test('pads to the SDK stored form, so an unpadded hash still matches', () => {
    // The withdraw modal used an UNPADDED variant, which is how it could miss a
    // leaf the hub found for the same note.
    expect(normalizeLeafHash('0xab')).toBe(padded(0xabn));
    expect(normalizeLeafHash('171')).toBe(padded(171n));
    expect(normalizeLeafHash(padded(0xabn))).toBe(padded(0xabn));
    expect(normalizeLeafHash('0xAB')).toBe(normalizeLeafHash('0xab'));
    expect(normalizeLeafHash('0X000Ab')).toBe(normalizeLeafHash('0xab'));
    expect(normalizeLeafHash('000171')).toBe(normalizeLeafHash('171'));
  });

  test('empty is null; unparseable falls back to lowercase rather than vanishing', () => {
    expect(normalizeLeafHash('')).toBeNull();
    expect(normalizeLeafHash(null)).toBeNull();
    expect(normalizeLeafHash('zz')).toBe('zz');
  });
});

describe('confirmSpendableCommitments', () => {
  const notes = [
    { commitment: '0xc1', label: '1' },   // hash 7
    { commitment: '0xc2', label: '2' },   // hash 14
    { commitment: '0xc3' },               // no label
  ];

  test('confirms exactly the notes whose label hash is published', () => {
    const confirmed = confirmSpendableCommitments({ notes, leaves: [padded(7n)], hashLabel });
    expect([...confirmed]).toEqual(['0xc1']);
  });

  test('matches regardless of the shape the leaves arrive in', () => {
    // Same leaf as a bare decimal and as an unpadded hex: both must match.
    for (const leaf of ['7', '0007', '0x7', '0X0007', padded(7n), padded(7n).toUpperCase()]) {
      const confirmed = confirmSpendableCommitments({ notes, leaves: [leaf], hashLabel });
      expect(confirmed.has('0xc1')).toBe(true);
    }
  });

  test('normalising both sides preserves every already-equal representation', () => {
    for (const value of ['7', '0x7', '0X07', padded(7n), padded(7n).toUpperCase(), 'zz']) {
      const confirmed = confirmSpendableCommitments({
        notes,
        leaves: [value],
        hashLabel: () => value,
      });
      expect(confirmed.has('0xc1')).toBe(true);
    }
  });

  test('a note without a label is skipped, never guessed', () => {
    const confirmed = confirmSpendableCommitments({
      notes, leaves: [padded(7n), padded(14n)], hashLabel,
    });
    expect(confirmed.has('0xc3')).toBe(false);
    expect(confirmed.size).toBe(2);
  });

  test('an empty published set confirms nothing', () => {
    expect(confirmSpendableCommitments({ notes, leaves: [], hashLabel }).size).toBe(0);
  });
});

describe('gate input identity', () => {
  const a = { commitment: '0xa', label: '0x1' };
  const b = { commitment: '0xb', label: '0x2' };

  test('new arrays and ordering do not change the note topology key', () => {
    expect(buildLeafGateNotesKey([a, b])).toBe(buildLeafGateNotesKey([{ ...b }, { ...a }]));
  });

  test('changed commitments or labels do change the note topology key', () => {
    const base = buildLeafGateNotesKey([a]);
    expect(buildLeafGateNotesKey([{ ...a, commitment: '0xc' }])).not.toBe(base);
    expect(buildLeafGateNotesKey([{ ...a, label: '0x3' }])).not.toBe(base);
  });

  test('a ready result is rejected for another key or leaf generation', () => {
    const leaves = [padded(7n)];
    const ready: LeafGate = { status: 'ready', confirmed: new Set(['0xa']) };
    const resolution = { key: 'chain-a', leaves, gate: ready };
    expect(resolveLeafGateForInputs(resolution, 'chain-a', leaves)).toBe(ready);
    expect(resolveLeafGateForInputs(resolution, 'chain-b', leaves)).toBe(LOADING_GATE);
    expect(resolveLeafGateForInputs(resolution, 'chain-a', [...leaves])).toBe(LOADING_GATE);
  });
});

describe('the two policies over ONE set of facts', () => {
  const ready: LeafGate = { status: 'ready', confirmed: new Set(['0xc1']) };

  test('while LOADING the surfaces deliberately disagree because the facts are unknown', () => {
    // Display must not flash a balance to zero; spending must not select a note
    // it cannot prove. This is the one intentional difference.
    expect(countsAsSpendableForDisplay(LOADING_GATE, '0xc1')).toBe(true);
    expect(isProvablySpendable(LOADING_GATE, '0xc1')).toBe(false);
  });

  test('a failed fetch stays explicit while display fails open and spending fails closed', () => {
    const failed = failedLeafGate('root mismatch');
    expect(failed.status).toBe('error');
    expect(countsAsSpendableForDisplay(failed, '0xc1')).toBe(true);
    expect(isProvablySpendable(failed, '0xc1')).toBe(false);
  });

  test('once READY they agree exactly — no screen can contradict itself', () => {
    for (const c of ['0xc1', '0xc2']) {
      expect(countsAsSpendableForDisplay(ready, c)).toBe(isProvablySpendable(ready, c));
    }
    expect(isProvablySpendable(ready, '0xc1')).toBe(true);
    expect(isProvablySpendable(ready, '0xc2')).toBe(false);
  });

  test('a ready-but-empty set means nothing is spendable, in BOTH policies', () => {
    const empty: LeafGate = { status: 'ready', confirmed: new Set() };
    expect(isProvablySpendable(empty, '0xc1')).toBe(false);
    expect(countsAsSpendableForDisplay(empty, '0xc1')).toBe(false);
  });
});
