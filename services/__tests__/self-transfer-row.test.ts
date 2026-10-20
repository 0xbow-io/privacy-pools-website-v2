import { describe, expect, test } from 'bun:test';
import {
  consolidationHeadline,
  isFeeAmountRow,
  noteCountText,
  selfTransferLabel,
} from '@/services/self-transfer-row';
import { rowTypeLabel } from '@/services/row-type-label';

describe('self-transfer rows', () => {
  test('a self row is a consolidation only when it carries consolidation counts, never from a local stamp', () => {
    expect(rowTypeLabel({ type: 'Transfer', direction: 'self', noteCounts: { spent: 3, created: 1 } })).toBe('Consolidation');
    expect(rowTypeLabel({ type: 'Transfer', direction: 'self' })).toBe('Self-transfer');
  });

  test('a consolidation leads with its note counts, as the consolidation panel writes them', () => {
    expect(noteCountText({ spent: 3, created: 1 })).toBe('3 notes → 1 note');
    expect(noteCountText({ spent: 1, created: 2 })).toBe('1 note → 2 notes');
    expect(consolidationHeadline({ direction: 'self', noteCounts: { spent: 3, created: 1 } })).toBe('3 notes → 1 note');
    expect(consolidationHeadline({ direction: 'self' })).toBeNull();
    expect(consolidationHeadline({ direction: 'out', noteCounts: { spent: 3, created: 1 } })).toBeNull();
  });

  test('only a self row states the fee as its amount', () => {
    expect(isFeeAmountRow({ direction: 'self' })).toBe(true);
    expect(isFeeAmountRow({ direction: 'out' })).toBe(false);
    expect(isFeeAmountRow({})).toBe(false);
  });

  test('copy uses no em dashes', () => {
    const copy = [
      selfTransferLabel({ spent: 3, created: 1 }),
      selfTransferLabel(undefined),
    ];
    for (const text of copy) expect(text).not.toContain('—');
  });
});
