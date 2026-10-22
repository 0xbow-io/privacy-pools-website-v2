import { describe, expect, test } from 'bun:test';
import { createLayoutPassBudget, createWidthDamper, LAYOUT_PASS_BUDGET } from '../layout-pass-budget';

/**
 * The hub pager's measure loop, reduced: width and height feed each other
 * (scrollbar on, narrower, rewrap, shorter, scrollbar off, wider...) and every
 * measurement that differs from state is written back, re-running the effect.
 */
function runMeasureLoop(takePass: () => boolean, limit = 1000) {
  let stateW = 0;
  let stateH = 0;
  let renders = 0;
  // Oscillating layout: never converges.
  const measure = (h: number) => ({ w: h > 500 ? 380 : 400, h: stateW === 380 ? 480 : 520 });
  for (;;) {
    renders += 1;
    if (renders > limit) return { renders, crashed: true };
    const m = measure(stateH);
    if (m.w !== stateW) {
      if (!takePass()) return { renders, crashed: false };
      stateW = m.w;
      continue;
    }
    if (m.h !== stateH) {
      if (!takePass()) return { renders, crashed: false };
      stateH = m.h;
      continue;
    }
    return { renders, crashed: false };
  }
}

describe('layout pass budget', () => {
  test('an oscillating width/height measure loop never settles without a budget (the #185 crash)', () => {
    expect(runMeasureLoop(() => true).crashed).toBe(true);
  });

  test('the budget stops the synchronous corrections within one frame', () => {
    const budget = createLayoutPassBudget();
    const run = runMeasureLoop(budget.take);
    expect(run.crashed).toBe(false);
    expect(run.renders).toBeLessThanOrEqual(LAYOUT_PASS_BUDGET + 1);
  });

  test('reset gives the next frame a full budget', () => {
    const budget = createLayoutPassBudget(2);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    expect(budget.spent).toBe(2);
    budget.reset();
    expect(budget.take()).toBe(true);
  });

  test('a converging layout uses only the passes it needs', () => {
    const budget = createLayoutPassBudget();
    let w = 0;
    let h = 0;
    let passes = 0;
    while (w !== 400 || h !== 300) {
      if (!budget.take()) break;
      passes += 1;
      if (w !== 400) w = 400; else h = 300;
    }
    expect(passes).toBe(2);
    expect(budget.spent).toBe(2);
  });
});

describe('width damper', () => {
  test('follows ordinary width changes', () => {
    const d = createWidthDamper();
    expect(d.next(400, 0)).toBe(400);
    expect(d.next(400, 400)).toBeNull();
    expect(d.next(600, 400)).toBe(600);
  });

  test('a scrollbar flip-flop settles on the narrower width and stays there', () => {
    const d = createWidthDamper();
    let w = 0;
    const commit = (m: number) => { const n = d.next(m, w); if (n !== null) w = n; return n; };
    commit(400); // first measure
    commit(385); // scrollbar appears
    commit(400); // scrollbar gone: flip back, cycle detected
    expect(w).toBe(385);
    // The cycle keeps reporting both values; nothing more is committed.
    for (let i = 0; i < 20; i += 1) expect(commit(i % 2 ? 385 : 400)).toBeNull();
    expect(w).toBe(385);
  });

  test('a genuine resize releases the pin', () => {
    const d = createWidthDamper();
    let w = 0;
    const commit = (m: number) => { const n = d.next(m, w); if (n !== null) w = n; };
    commit(400); commit(385); commit(400);
    commit(700);
    expect(w).toBe(700);
  });
});
