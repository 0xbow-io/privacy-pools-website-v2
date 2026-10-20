import { describe, expect, test } from 'bun:test';

import { initialLatch, stepLatch, type LatchState } from '@/services/latched-value';

/** Drive the latch through a sequence of [live, frozen] steps. */
function run<T>(steps: [T | undefined, boolean][]): (T | undefined)[] {
  let s: LatchState<T> = initialLatch<T>();
  const seen: (T | undefined)[] = [];
  for (const [live, frozen] of steps) {
    s = stepLatch(s, live, frozen);
    seen.push(s.value);
  }
  return seen;
}

describe('stepLatch', () => {
  test('open, it just tracks the live value', () => {
    expect(run([[1, false], [2, false], [3, false]])).toEqual([1, 2, 3]);
  });

  // The whole point: the poll keeps running and keeps landing, but what the
  // user sees does not move while their transaction is in flight.
  test('closed, it holds what was showing and ignores every arrival', () => {
    expect(run([
      [100, false], // balance loaded
      [100, true], // send begins
      [90, true], // a poll lands mid-send
      [80, true], // and another
    ])).toEqual([100, 100, 100, 100]);
  });

  test('re-opening takes the live value, not the stale held one', () => {
    expect(run([
      [100, false],
      [100, true],
      [90, true],
      [90, false], // settled
    ])).toEqual([100, 100, 100, 90]);
  });

  test('freezing before anything loaded shows nothing rather than inventing a figure', () => {
    expect(run([[undefined, true], [42, true]])).toEqual([undefined, undefined]);
    // ...and the first value after it opens is the live one.
    expect(run([[undefined, true], [42, true], [42, false]])).toEqual([undefined, undefined, 42]);
  });

  test('a second transaction holds the value from the second close, not the first', () => {
    expect(run([
      [10, false],
      [10, true], // tx 1
      [20, false], // settled, balance moved
      [20, true], // tx 2
      [30, true], // a poll lands
    ])).toEqual([10, 10, 20, 20, 20]);
  });

  test('works for a non-primitive, holding the same reference', () => {
    const a = { total: 1n };
    const b = { total: 2n };
    const seen = run<{ total: bigint }>([[a, false], [a, true], [b, true]]);
    expect(seen[2]).toBe(a);
  });

  // Idempotence is what lets the hook call setState during render without
  // looping: re-stepping a settled state must be a no-op in every field, not
  // just in the value the UI reads.
  test('re-stepping a settled state changes nothing, so the hook cannot loop', () => {
    for (const frozen of [false, true]) {
      let s = stepLatch(initialLatch<number>(), 1, false);
      s = stepLatch(s, 2, frozen);
      const again = stepLatch(s, 2, frozen);
      expect(again).toEqual(s);
    }
  });
});

describe('stepLatch identity — whose value is being held', () => {
  /** Drive with an explicit identity per step. */
  function runWithIdentity<T>(steps: [T | undefined, boolean, string][]): (T | undefined)[] {
    let s = initialLatch<T>();
    const seen: (T | undefined)[] = [];
    for (const [live, frozen, id] of steps) {
      s = stepLatch(s, live, frozen, id);
      seen.push(s.value);
    }
    return seen;
  }

  // The bug this closes: freeze on account A, switch to B mid-send, and the
  // frozen figure just stays there — A's balance under B's name.
  test('an identity change while frozen drops the held value instead of showing it', () => {
    expect(runWithIdentity([
      [100, false, 'A'], // A's balance
      [100, true, 'A'], // A starts a send
      [undefined, true, 'B'], // user switches account; B has not loaded
      [7, true, 'B'], // B's balance arrives while still frozen
    ])).toEqual([100, 100, undefined, undefined]);
    // ...and it never shows A's number under B.
  });

  test('an identity change while open takes the new value immediately', () => {
    expect(runWithIdentity([
      [100, false, 'A'],
      [7, false, 'B'],
    ])).toEqual([100, 7]);
  });

  test('the same identity behaves exactly as before', () => {
    expect(runWithIdentity([
      [100, false, 'A'],
      [100, true, 'A'],
      [90, true, 'A'],
    ])).toEqual([100, 100, 100]);
  });

  test('switching back to a previous identity does not resurrect its old held value', () => {
    expect(runWithIdentity([
      [100, false, 'A'],
      [100, true, 'A'],
      [7, true, 'B'],
      [undefined, true, 'A'], // back to A, still mid-send
    ])).toEqual([100, 100, undefined, undefined]);
  });
});
