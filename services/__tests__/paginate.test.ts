import { describe, expect, test } from 'bun:test';

import { paginate } from '../paginate';

describe('paginate', () => {
  test('slices a full first page', () => {
    expect(paginate(15, 10, 0)).toEqual({ page: 0, pageCount: 2, start: 0, end: 10 });
  });

  test('slices a partial last page', () => {
    expect(paginate(15, 10, 1)).toEqual({ page: 1, pageCount: 2, start: 10, end: 15 });
  });

  test('reports one page for an empty list, never zero', () => {
    // "Page 1 of 0" is not a thing a viewer can be on.
    expect(paginate(0, 10, 0)).toEqual({ page: 0, pageCount: 1, start: 0, end: 0 });
  });

  test('reports one page when the list exactly fills it', () => {
    expect(paginate(10, 10, 0)).toEqual({ page: 0, pageCount: 1, start: 0, end: 10 });
  });

  test('clamps a page index the list has shrunk past', () => {
    // The viewer was on page 3 of 3 and the list dropped to 12 rows: without
    // the clamp they would sit on an empty page with no way back.
    expect(paginate(12, 10, 2)).toEqual({ page: 1, pageCount: 2, start: 10, end: 12 });
  });

  test('clamps to the only page when the list empties entirely', () => {
    expect(paginate(0, 10, 7)).toEqual({ page: 0, pageCount: 1, start: 0, end: 0 });
  });

  test('refuses a negative or fractional raw index', () => {
    expect(paginate(15, 10, -3)).toEqual({ page: 0, pageCount: 2, start: 0, end: 10 });
    expect(paginate(15, 10, 1.7)).toEqual({ page: 1, pageCount: 2, start: 10, end: 15 });
    expect(paginate(15, 10, NaN)).toEqual({ page: 0, pageCount: 2, start: 0, end: 10 });
  });

  test('survives a non-positive page size instead of dividing into Infinity pages', () => {
    expect(paginate(3, 0, 0)).toEqual({ page: 0, pageCount: 3, start: 0, end: 1 });
  });

  test('never returns an end past the total', () => {
    for (const total of [0, 1, 9, 10, 11, 15, 100]) {
      for (let p = 0; p < 5; p++) {
        const r = paginate(total, 10, p);
        expect(r.end).toBeLessThanOrEqual(total);
        expect(r.start).toBeLessThanOrEqual(r.end);
        expect(r.page).toBeLessThan(r.pageCount);
      }
    }
  });
});
