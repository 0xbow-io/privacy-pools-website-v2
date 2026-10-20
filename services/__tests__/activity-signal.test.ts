import { describe, expect, test } from 'bun:test';

import { ALWAYS_ACTIVE, createActivitySignal, INPUT_IDLE_MS, whenActive } from '@/services/activity-signal';

type Listener = () => void;

function fakeTarget() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener: (type: string, fn: Listener) => {
      const set = listeners.get(type) ?? new Set<Listener>();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, fn: Listener) => {
      listeners.get(type)?.delete(fn);
    },
    fire: (type: string) => {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

function harness(opts: { visible?: boolean; focused?: boolean } = {}) {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const state = { visible: opts.visible ?? true, focused: opts.focused ?? true };
  // defineProperty, not Object.assign: assign would read the getter once and
  // freeze the value.
  const doc = Object.defineProperty(Object.assign(fakeTarget(), { hasFocus: () => state.focused }), 'visibilityState', {
    get: () => (state.visible ? 'visible' : 'hidden'),
  }) as ReturnType<typeof fakeTarget> & { hasFocus: () => boolean; visibilityState: string };
  const win = fakeTarget();
  const signal = createActivitySignal({
    document: doc,
    window: win,
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle) => { timers.delete(handle as number); },
  });
  const changes: boolean[] = [];
  signal.subscribe((active) => changes.push(active));
  return {
    signal,
    doc,
    win,
    state,
    changes,
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = target;
    },
  };
}

describe('activity signal', () => {
  test('visible and focused is active', () => {
    const h = harness();
    h.advance(0);
    expect(h.signal.isActive()).toBe(true);
    h.advance(INPUT_IDLE_MS * 3);
    // Focus alone keeps it active, however long nobody touches anything.
    expect(h.signal.isActive()).toBe(true);
  });

  test('visible, unfocused, with recent input is active', () => {
    const h = harness({ focused: false });
    h.advance(0);
    expect(h.signal.isActive()).toBe(true);
    h.advance(INPUT_IDLE_MS - 60_000);
    h.win.fire('pointermove');
    h.advance(INPUT_IDLE_MS - 1_000);
    expect(h.signal.isActive()).toBe(true);
  });

  test('visible, unfocused, idle for five minutes is inactive, and input wakes it', () => {
    const h = harness({ focused: false });
    h.advance(INPUT_IDLE_MS + 1);
    expect(h.signal.isActive()).toBe(false);
    expect(h.changes).toEqual([false]);
    h.win.fire('keydown');
    expect(h.signal.isActive()).toBe(true);
    expect(h.changes).toEqual([false, true]);
  });

  test('blurring starts the idle clock; focusing again makes it active', () => {
    const h = harness();
    h.advance(10 * 60_000);
    h.state.focused = false;
    h.win.fire('blur');
    expect(h.signal.isActive()).toBe(true);
    h.advance(INPUT_IDLE_MS + 1);
    expect(h.signal.isActive()).toBe(false);
    h.state.focused = true;
    h.win.fire('focus');
    expect(h.signal.isActive()).toBe(true);
  });

  test('hidden is inactive, whatever the focus and input say', () => {
    const h = harness();
    h.state.visible = false;
    h.doc.fire('visibilitychange');
    expect(h.signal.isActive()).toBe(false);
    h.win.fire('pointerdown');
    expect(h.signal.isActive()).toBe(false);
    h.state.visible = true;
    h.doc.fire('visibilitychange');
    expect(h.signal.isActive()).toBe(true);
  });

  test('a page that loads hidden starts inactive', () => {
    const h = harness({ visible: false });
    expect(h.signal.isActive()).toBe(false);
  });

  test('frozen is inactive until resumed', () => {
    const h = harness();
    h.doc.fire('freeze');
    expect(h.signal.isActive()).toBe(false);
    h.doc.fire('resume');
    expect(h.signal.isActive()).toBe(true);
  });

  test('focus is re-read after startup, since events only report changes', () => {
    const h = harness({ focused: false });
    // hasFocus() reads false during early load, true once the task settles.
    h.state.focused = true;
    h.advance(0);
    h.advance(INPUT_IDLE_MS * 2);
    expect(h.signal.isActive()).toBe(true);
  });

  test('dispose removes every listener', () => {
    const h = harness();
    expect(h.win.count() + h.doc.count()).toBeGreaterThan(0);
    h.signal.dispose();
    expect(h.win.count() + h.doc.count()).toBe(0);
  });

  test('without a DOM it is always active', () => {
    expect(ALWAYS_ACTIVE.isActive()).toBe(true);
  });

  test('whenActive defers a first fetch in a hidden tab until someone arrives', async () => {
    const h = harness({ visible: false });
    let resolved = false;
    const waiting = whenActive(h.signal).then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);
    h.state.visible = true;
    h.doc.fire('visibilitychange');
    await waiting;
    expect(resolved).toBe(true);
    // Already active: no wait at all.
    await whenActive(h.signal);
  });
});
