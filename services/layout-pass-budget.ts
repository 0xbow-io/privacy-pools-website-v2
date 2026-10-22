/**
 * A cap on how many state corrections a measuring layout effect may make
 * before the browser gets to paint.
 *
 * The hub's pager measures its width and the active page's height in a
 * useLayoutEffect and writes each back to state, which re-runs the effect
 * synchronously. When the two feed each other (a taller page brings up the
 * window scrollbar, the narrower pager rewraps the swap estimate line, the page
 * gets shorter, the scrollbar goes away, and around again) the corrections
 * never converge and React throws "Maximum update depth exceeded" (#185). That
 * crashed the Swap tab on prod after typing an amount (2026-10-21).
 *
 * The effect takes a pass before each write. Once the budget is spent it stops
 * correcting until the next frame, when `reset` gives it a fresh budget; the
 * pages' own onLayout handlers keep the figures current from there.
 */
export const LAYOUT_PASS_BUDGET = 6;

export type LayoutPassBudget = {
  /** True when another synchronous correction is allowed this frame. */
  take: () => boolean;
  /** A new frame: the budget is full again. */
  reset: () => void;
  /** Passes used since the last reset. */
  readonly spent: number;
};

export function createLayoutPassBudget(max = LAYOUT_PASS_BUDGET): LayoutPassBudget {
  let used = 0;
  return {
    take: () => {
      if (used >= max) return false;
      used += 1;
      return true;
    },
    reset: () => { used = 0; },
    get spent() { return used; },
  };
}

/**
 * The budget above stops the synchronous loop, but a width/height cycle can
 * still flip at frame rate through onLayout (claude-review on #317). This
 * damps it at the source: a measured width that only flips back to the value
 * from two measurements ago is the scrollbar cycle, so the pager settles on the
 * narrower of the two (content always fits; the wider one would clip a
 * scrollbar's worth) and holds it until a genuinely new width arrives.
 *
 * `next` returns the width to commit, or null when nothing should change.
 */
export type WidthDamper = { next: (measured: number, current: number) => number | null };

export function createWidthDamper(): WidthDamper {
  let previous: number | null = null; // the width before `current`
  let pinned: { a: number; b: number } | null = null;
  return {
    next: (measured, current) => {
      if (pinned) {
        if (measured === pinned.a || measured === pinned.b) {
          const settle = Math.min(pinned.a, pinned.b);
          return settle === current ? null : settle;
        }
        pinned = null; // a real resize: follow it again
      }
      if (measured === current) return null;
      if (previous !== null && measured === previous) {
        pinned = { a: measured, b: current };
        const settle = Math.min(measured, current);
        return settle === current ? null : settle;
      }
      previous = current;
      return measured;
    },
  };
}
