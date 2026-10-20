import { describe, expect, test } from 'bun:test';

import { DISCOVERY_GRID, PRICE_GRID, phaseShift, type GridKeepOut } from '../e2e/window-phase';

const W = 65_000;
const OFFSET = 2 * W;

function instantsIn(from: number, to: number, period: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(from / period) * period; t < to; t += period) out.push(t);
  return out;
}

describe('phaseShift keeps grid instants out of the action window', () => {
  test('for every starting phase, the shifted action window holds no instant', () => {
    const grids = [PRICE_GRID, DISCOVERY_GRID];
    for (let now = 0; now < 10 * 60_000; now += 7_000) {
      const shift = phaseShift(now, OFFSET, W, grids);
      expect(shift).not.toBeNull();
      const start = now + shift! + OFFSET;
      for (const g of grids) expect(instantsIn(start - g.beforeMs, start + W, g.periodMs)).toEqual([]);
    }
  });

  test('a phase that is already clear is not delayed', () => {
    // Action starts 40s past a 2-minute instant and far from the 5-minute one.
    const now = 10 * 60_000 + 40_000 - OFFSET;
    expect(phaseShift(now, OFFSET, W, [PRICE_GRID, DISCOVERY_GRID])).toBe(0);
  });

  test('a window that cannot fit between instants is an error, not a pass', () => {
    const tight: GridKeepOut = { name: 'tight', periodMs: 60_000, beforeMs: 10_000 };
    expect(() => phaseShift(0, OFFSET, W, [tight])).toThrow();
  });
});
