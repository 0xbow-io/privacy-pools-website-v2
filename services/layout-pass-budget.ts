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
 * damps it at the source. A measured width that flips back to the value from
 * two measurements ago is the scrollbar cycle only when the two widths are a
 * scrollbar apart and the flip comes right after the last change. Then the
 * pager settles on the narrower one (content always fits, the wider one would
 * clip a scrollbar's worth) for a short hold.
 *
 * Anything else is a real resize and is followed: a big jump (rotate, window
 * maximize/restore), a slow flip back (devtools opened then closed), a new
 * width, the hold running out, or `release()` (the window resize event).
 *
 * `next` returns the width to commit, or null when nothing should change.
 */
export const SCROLLBAR_MAX_DELTA = 24;
export const FLIP_WINDOW_MS = 250;
export const PIN_HOLD_MS = 2000;

export type WidthDamper = {
  next: (measured: number, current: number) => number | null;
  /** Drop the pin and the history: the next width is followed as is. */
  release: () => void;
};

export type WidthDamperOptions = {
  maxDelta?: number;
  windowMs?: number;
  holdMs?: number;
  now?: () => number;
};

export function createWidthDamper({
  maxDelta = SCROLLBAR_MAX_DELTA,
  windowMs = FLIP_WINDOW_MS,
  holdMs = PIN_HOLD_MS,
  now = Date.now,
}: WidthDamperOptions = {}): WidthDamper {
  let previous: number | null = null; // the width before `current`
  let changedAt = -Infinity; // when `current` was committed
  let pinned: { a: number; b: number; until: number } | null = null;
  const follow = (measured: number, current: number, at: number) => {
    previous = current;
    changedAt = at;
    return measured;
  };
  return {
    next: (measured, current) => {
      const at = now();
      if (pinned) {
        const inPair = measured === pinned.a || measured === pinned.b;
        if (inPair && at <= pinned.until) {
          const settle = Math.min(pinned.a, pinned.b);
          return settle === current ? null : settle;
        }
        pinned = null; // a new width or the hold ran out: follow it again
        previous = null;
      }
      if (measured === current) return null;
      const isScrollbarFlip = previous !== null
        && measured === previous
        && Math.abs(measured - current) <= maxDelta
        && at - changedAt <= windowMs;
      if (isScrollbarFlip) {
        pinned = { a: measured, b: current, until: at + holdMs };
        const settle = Math.min(measured, current);
        return settle === current ? null : settle;
      }
      return follow(measured, current, at);
    },
    release: () => {
      pinned = null;
      previous = null;
    },
  };
}
