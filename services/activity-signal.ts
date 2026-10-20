/**
 * Is someone using this tab right now?
 *
 * One signal, read by everything that polls in the background: the public-feed
 * grid (services/public-feed-scheduler.ts) and React Query's focusManager
 * (app/_layout.tsx). A tab nobody is using sends nothing, and picks up again on
 * the normal cadence once someone is back, without a catch-up burst.
 *
 *   active = the tab is visible
 *        AND (the window has focus OR there was input in the last 5 minutes)
 *        AND the page is not frozen (Page Lifecycle freeze/resume)
 *
 * Web only. No permission prompt and no Idle Detection API: focus, visibility
 * and a timestamp of the last input are all it reads. Without a `document`
 * (native) the signal is always active, so native behaviour is unchanged.
 *
 * PRIVACY. Going quiet when inactive is a presence signal (the ASP can tell a
 * tab is idle), not a funds signal: nothing here depends on notes, balances or
 * what the user is doing inside the app, only on whether anyone is there.
 *
 * Pure module: the document, window and clock are injected so bun tests can
 * drive it with fakes.
 */

/** Input older than this, with the window unfocused, counts as idle. */
export const INPUT_IDLE_MS = 5 * 60_000;

/** Window events that count as the user being there. Passive, timestamp only. */
const INPUT_EVENTS = ['pointermove', 'pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'] as const;

type Target = {
  addEventListener: (type: string, fn: () => void, opts?: AddEventListenerOptions | boolean) => void;
  removeEventListener: (type: string, fn: () => void, opts?: EventListenerOptions | boolean) => void;
};

export type ActivityEnv = {
  document: Target & { visibilityState?: string; hasFocus?: () => boolean };
  window: Target;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type ActivitySignal = {
  isActive: () => boolean;
  /** Called with the new value whenever it flips. Returns an unsubscribe. */
  subscribe: (listener: (active: boolean) => void) => () => void;
};

/** Native, SSR, tests: nobody to watch, so nothing is ever gated. */
export const ALWAYS_ACTIVE: ActivitySignal = Object.freeze({
  isActive: () => true,
  subscribe: () => () => {},
});

export function createActivitySignal(env: ActivityEnv): ActivitySignal & { dispose: () => void } {
  const { document: doc, window: win } = env;
  const readFocus = (): boolean => {
    try {
      return typeof doc.hasFocus === 'function' ? doc.hasFocus() : true;
    } catch {
      return true;
    }
  };
  let visible = doc.visibilityState !== 'hidden';
  let focused = readFocus();
  let frozen = false;
  // Loading the page is input: the user just navigated here.
  let lastInputAt = env.now();
  let idleTimer: unknown;
  const listeners = new Set<(active: boolean) => void>();

  const compute = (): boolean => visible && !frozen && (focused || env.now() - lastInputAt < INPUT_IDLE_MS);
  let active = compute();

  const armIdleTimer = (): void => {
    if (idleTimer !== undefined) return;
    // Only an unfocused, visible tab can go idle by the clock.
    if (!active || focused) return;
    const wait = Math.max(0, lastInputAt + INPUT_IDLE_MS - env.now());
    idleTimer = env.setTimeout(() => {
      idleTimer = undefined;
      update();
    }, wait);
  };

  const update = (): void => {
    const next = compute();
    if (idleTimer !== undefined && (!next || focused)) {
      env.clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (next !== active) {
      active = next;
      for (const listener of [...listeners]) {
        try {
          listener(active);
        } catch {
          /* one bad subscriber must not stop the others */
        }
      }
    }
    // Re-arm on every evaluation, not on every input: input only stamps a time,
    // and the timer re-reads it when it fires.
    armIdleTimer();
  };

  const onInput = (): void => {
    lastInputAt = env.now();
    // The only per-event work beyond the stamp: wake an idle tab.
    if (!active) update();
  };
  const onVisibility = (): void => {
    visible = doc.visibilityState !== 'hidden';
    focused = readFocus();
    update();
  };
  const onFocus = (): void => {
    focused = true;
    lastInputAt = env.now();
    update();
  };
  const onBlur = (): void => {
    focused = false;
    // Leaving the window is the last moment we know someone was here.
    lastInputAt = env.now();
    update();
  };
  const onFreeze = (): void => {
    frozen = true;
    update();
  };
  const onResume = (): void => {
    frozen = false;
    visible = doc.visibilityState !== 'hidden';
    focused = readFocus();
    update();
  };

  const passive: AddEventListenerOptions = { passive: true, capture: true };
  for (const type of INPUT_EVENTS) win.addEventListener(type, onInput, passive);
  win.addEventListener('focus', onFocus);
  win.addEventListener('blur', onBlur);
  doc.addEventListener('visibilitychange', onVisibility);
  doc.addEventListener('freeze', onFreeze);
  doc.addEventListener('resume', onResume);

  // Focus events only report changes, and hasFocus() can read false during
  // early load, so read it once more after the current task.
  const startupTimer = env.setTimeout(() => {
    focused = readFocus();
    update();
  }, 0);
  armIdleTimer();

  return {
    isActive: () => active,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      env.clearTimeout(startupTimer);
      if (idleTimer !== undefined) env.clearTimeout(idleTimer);
      idleTimer = undefined;
      listeners.clear();
      for (const type of INPUT_EVENTS) win.removeEventListener(type, onInput, passive);
      win.removeEventListener('focus', onFocus);
      win.removeEventListener('blur', onBlur);
      doc.removeEventListener('visibilitychange', onVisibility);
      doc.removeEventListener('freeze', onFreeze);
      doc.removeEventListener('resume', onResume);
    },
  };
}

/**
 * Resolves now if someone is using the tab, else the moment someone is.
 *
 * For the first fetch of a background ASP query: focusManager only stops
 * React Query's INTERVAL ticks, a query mounted in a tab that loaded hidden
 * still fetches on mount. Awaiting this at the top of its queryFn defers that
 * first request to the user's arrival, which is the same moment the feed grid
 * bootstraps. Never use it on a flow the user started (a withdraw keeps going
 * if they switch tabs), only on background polls.
 */
export function whenActive(signal: ActivitySignal = activitySignal()): Promise<void> {
  if (signal.isActive()) return Promise.resolve();
  return new Promise((resolve) => {
    const off = signal.subscribe((active) => {
      if (!active) return;
      off();
      resolve();
    });
  });
}

let shared: ActivitySignal | undefined;

/** The app's single signal. Always active where there is no DOM (native). */
export function activitySignal(): ActivitySignal {
  if (shared) return shared;
  const g = globalThis as { document?: ActivityEnv['document']; window?: ActivityEnv['window'] };
  if (!g.document || !g.window || typeof g.document.addEventListener !== 'function'
    || typeof g.window.addEventListener !== 'function') {
    shared = ALWAYS_ACTIVE;
    return shared;
  }
  shared = createActivitySignal({
    document: g.document,
    window: g.window,
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  return shared;
}
