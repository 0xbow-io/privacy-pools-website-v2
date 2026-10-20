import { describe, expect, test } from 'bun:test';
import { withoutStrandedPendingNote } from '../pending-note-cleanup';

const C = '0x00000000000000000000000000000000000000000000000000000000000000ab';
const blob = (notes: Array<{ commitment?: string; status?: string }>) => ({ notes, syncCursor: '0x1' });

describe('withoutStrandedPendingNote', () => {
  test('removes exactly the PENDING note with that commitment', () => {
    const out = withoutStrandedPendingNote(blob([{ commitment: C, status: 'PENDING' }, { commitment: '0x01', status: 'ACTIVE' }]), C);
    expect(out.notes.map((n) => n.commitment)).toEqual(['0x01']);
  });

  test('matches the commitment in any spelling (padded, unpadded, decimal, case)', () => {
    for (const spelling of ['0xab', '0xAB', '171', C.toUpperCase()]) {
      expect(withoutStrandedPendingNote(blob([{ commitment: C, status: 'pending' }]), spelling).notes).toEqual([]);
    }
  });

  test('NEVER removes an ACTIVE note — that means the deposit landed after all', () => {
    const b = blob([{ commitment: C, status: 'ACTIVE' }]);
    expect(withoutStrandedPendingNote(b, C)).toBe(b);
  });

  test('returns the same object when nothing matched, so callers skip the write', () => {
    const b = blob([{ commitment: '0x01', status: 'PENDING' }]);
    expect(withoutStrandedPendingNote(b, C)).toBe(b);
    expect(withoutStrandedPendingNote({ syncCursor: '0x1' } as never, C)).toEqual({ syncCursor: '0x1' });
  });

  test('carries every other field of the export through untouched', () => {
    const b = { notes: [{ commitment: C, status: 'PENDING' }], syncCursor: '0x5', owner: '0xabc', paymentRequests: [1] };
    const out = withoutStrandedPendingNote(b, C);
    expect(out).toEqual({ notes: [], syncCursor: '0x5', owner: '0xabc', paymentRequests: [1] });
  });
});
