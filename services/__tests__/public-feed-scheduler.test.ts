import { describe, expect, test } from 'bun:test';

import { EMPTY_FEED_STATE, feedData, PublicFeedScheduler, type FeedState } from '@/services/public-feed-scheduler';

async function settle() {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

/**
 * A fake clock with a queue, so a test can advance time deterministically and
 * assert on WHEN a fetch happened. The scheduler's whole point is the schedule,
 * so a test that could not see the schedule would not be testing it.
 */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    clock: {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextId;
        nextId += 1;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (handle: unknown) => {
        timers.delete(handle as number);
      },
    },
    /** Advance to `now + ms`, firing everything due, in time order. */
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, t]) => t.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = Math.max(now, timer.at);
        timer.fn();
        // Let the fetch promise settle before the next timer fires.
        await settle();
      }
      now = target;
    },
    // Jump without running timers to simulate a blocked/suspended JS thread.
    setNow(t: number) {
      now = t;
    },
    fireNext() {
      const [id, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      timers.delete(id);
      now = Math.max(now, timer.at);
      timer.fn();
    },
    now: () => now,
  };
}

describe('the cadence is a fixed wall-clock grid', () => {
  test('the next tick is an absolute multiple of the period, not "period from now"', () => {
    const s = new PublicFeedScheduler();
    // The grid is epoch-absolute: from 1_000_007 the next multiple of 60_000
    // is 1_020_000, so this client waits 19_993ms, not a full period. A client
    // that arrived 34ms later waits 19_959ms and lands on the SAME instant.
    // That is the property: the phase of our polling cannot encode when we
    // arrived, because there is no per-client phase.
    expect(s.msUntilNextTick(60_000, 1_000_007)).toBe(19_993);
    expect(s.msUntilNextTick(60_000, 1_000_041)).toBe(19_959);
    expect(s.msUntilNextTick(60_000, 1_000_007) + 1_000_007).toBe(1_020_000);
    expect(s.msUntilNextTick(60_000, 1_000_041) + 1_000_041).toBe(1_020_000);
  });

  test('a client exactly on the grid waits a full period, never fires twice', () => {
    const s = new PublicFeedScheduler();
    expect(s.msUntilNextTick(60_000, 1_020_000)).toBe(60_000);
  });

  test('two clients that started at different times converge', async () => {
    // Run both to the SAME absolute instant, not for the same duration: the
    // claim is that their requests land together, not that they make the same
    // number of them from arbitrary starts.
    const runFrom = async (startMs: number) => {
      const f = fakeClock();
      f.setNow(startMs);
      const s = new PublicFeedScheduler(f.clock);
      const at: number[] = [];
      s.register({ key: 'k', intervalMs: 1000, fetch: async () => { at.push(f.now()); return 1; } });
      s.start();
      await f.advance(20_000 - startMs);
      s.stop();
      // Drop the load-time fetch; only the recurring ones are on the grid.
      return at.slice(1);
    };
    const early = await runFrom(10_007);
    const late = await runFrom(10_741);
    expect(early.length).toBeGreaterThan(5);
    // Everything the later client asked for, the earlier one asked for at the
    // very same instant.
    expect(late).toEqual(early.filter((t) => t > 10_741));
    expect(early.every((t) => t % 1000 === 0)).toBe(true);
  });
});

describe('nothing the user does changes the schedule', () => {
  test('there is no way to ask for a fetch: read is pure', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    let calls = 0;
    s.register({ key: 'k', intervalMs: 1000, fetch: async () => { calls += 1; return calls; } });
    // Reading before start, and reading many times, must not fetch. A
    // component that could pull data on render is a component that leaks by
    // being looked at.
    for (let i = 0; i < 5; i += 1) expect(s.read('k')).toEqual({ status: 'empty' });
    expect(calls).toBe(0);
    // The public surface offers no refetch/invalidate door either.
    expect('refetch' in s).toBe(false);
    expect('invalidate' in s).toBe(false);
  });

  test('the cadence is identical whether or not a transaction is in flight', async () => {
    // The regression for the silence channel. Every public feed used to be
    // gated `refetchInterval: txPending ? false : N`, so the ASP saw this
    // client go quiet for exactly as long as a withdrawal took to settle. The
    // scheduler has no concept of a pending transaction, and this asserts it
    // stays that way: the count over a fixed span cannot depend on app state
    // because no app state reaches it.
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    const at: number[] = [];
    s.register({ key: 'k', intervalMs: 1000, fetch: async () => { at.push(f.now()); return 1; } });
    s.start();
    await f.advance(5000);
    s.stop();
    expect(at).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
  });
});

describe('failure does not become a schedule of its own', () => {
  test('an error keeps the last good value and does not change the cadence', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    let n = 0;
    const at: number[] = [];
    s.register({
      key: 'k',
      intervalMs: 1000,
      fetch: async () => {
        at.push(f.now());
        n += 1;
        if (n === 2) throw new Error('ASP down');
        return n;
      },
    });
    s.start();
    await f.advance(2000);
    s.stop();
    // Three attempts on the grid: no retry storm, no backoff that would make
    // this client's traffic pattern distinctive.
    expect(at).toEqual([0, 1000, 2000]);
    const state = s.read<number>('k');
    expect(state.status).toBe('ready');
    expect(state.status === 'ready' && state.data).toBe(3);
  });

  test('an error before any success reports the error and no data', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    s.register({ key: 'k', intervalMs: 1000, fetch: async () => { throw new Error('boom'); } });
    s.start();
    await f.advance(0);
    const state: FeedState = s.read('k');
    expect(state.status).toBe('error');
    expect(state.status === 'error' && state.error.message).toBe('boom');
    expect(state.status === 'error' && state.data).toBeUndefined();
    s.stop();
  });

  test('a later error keeps serving the last good value', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    let n = 0;
    s.register({
      key: 'k',
      intervalMs: 1000,
      fetch: async () => {
        n += 1;
        if (n > 1) throw new Error('ASP down');
        return 'good';
      },
    });
    s.start();
    await f.advance(1000);
    s.stop();
    const state = s.read<string>('k');
    expect(state.status).toBe('error');
    expect(state.status === 'error' && state.data).toBe('good');
  });
});

describe('a feed its consumers cannot do without retries on a shorter grid until it has data', () => {
  test('failures before the first data retry on the retry grid, then the feed rejoins its own', async () => {
    const f = fakeClock();
    f.setNow(7_000);
    const s = new PublicFeedScheduler(f.clock);
    const at: number[] = [];
    let n = 0;
    s.register({
      key: 'k',
      intervalMs: 60_000,
      retryMs: 15_000,
      fetch: async () => {
        at.push(f.now());
        n += 1;
        if (n <= 2) throw new Error('502 Bad Gateway');
        return 'key';
      },
    });
    s.start();
    await f.advance(173_000);
    s.stop();
    // The retries land on the wall-clock retry grid (15s, 30s), not on
    // "failure + 15s", so they say nothing about when this client arrived.
    expect(at).toEqual([7_000, 15_000, 30_000, 60_000, 120_000, 180_000]);
    expect(feedData(s.read<string>('k'))).toBe('key');
  });

  test('a feed holding data keeps its normal cadence when a refresh fails', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    const at: number[] = [];
    let n = 0;
    s.register({
      key: 'k',
      intervalMs: 60_000,
      retryMs: 15_000,
      fetch: async () => {
        at.push(f.now());
        n += 1;
        if (n === 2) throw new Error('502 Bad Gateway');
        return n;
      },
    });
    s.start();
    await f.advance(120_000);
    s.stop();
    expect(at).toEqual([0, 60_000, 120_000]);
  });

  test('a retry grid that is not a divisor of the period is refused', () => {
    const s = new PublicFeedScheduler();
    expect(() => s.register({ key: 'a', intervalMs: 60_000, retryMs: 25_000, fetch: async () => 1 })).toThrow();
    expect(() => s.register({ key: 'b', intervalMs: 60_000, retryMs: 60_000, fetch: async () => 1 })).toThrow();
    expect(() => s.register({ key: 'c', intervalMs: 60_000, retryMs: 0, fetch: async () => 1 })).toThrow();
    expect(() => s.register({ key: 'd', intervalMs: 60_000, retryMs: 15_000, fetch: async () => 1 })).not.toThrow();
  });
});

describe('a slow feed skips instants instead of queueing a burst', () => {
  test('only one request per feed is ever in flight', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    let started = 0;
    let release: (() => void) | undefined;
    s.register({
      key: 'slow',
      intervalMs: 1000,
      fetch: () => {
        started += 1;
        return new Promise<number>((resolve) => {
          release = () => resolve(started);
        });
      },
    });
    s.start();
    await f.advance(4000);
    // Five grid instants passed; one request is outstanding the whole time.
    expect(started).toBe(1);
    release?.();
    await Promise.resolve();
    s.stop();
  });
});

describe('registration', () => {
  test('registration lists the declared keys', () => {
    const s = new PublicFeedScheduler();
    s.register({ key: 'k', intervalMs: 1000, fetch: async () => 1 });
    // Registration exposes the expected key. Zero arguments alone cannot
    // prevent a callback from closing over user state; definitions need review.
    expect(s.registered()).toEqual(['k']);
  });

  test('a nonsense interval is refused rather than silently never firing', () => {
    const s = new PublicFeedScheduler();
    expect(() => s.register({ key: 'a', intervalMs: 0, fetch: async () => 1 })).toThrow();
    expect(() => s.register({ key: 'b', intervalMs: -1, fetch: async () => 1 })).toThrow();
    expect(() => s.register({ key: 'c', intervalMs: NaN, fetch: async () => 1 })).toThrow();
  });

  test('registering two different feeds under one key is refused', () => {
    const s = new PublicFeedScheduler();
    const feed = { key: 'k', intervalMs: 1000, fetch: async () => 1 };
    s.register(feed);
    s.register(feed); // the same object again is a no-op, not an error
    expect(() => s.register({ key: 'k', intervalMs: 1000, fetch: async () => 2 })).toThrow();
  });

  test('a feed registered after start joins the cadence', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    s.start();
    const at: number[] = [];
    s.register({ key: 'late', intervalMs: 1000, fetch: async () => { at.push(f.now()); return 1; } });
    await f.advance(2000);
    s.stop();
    expect(at).toEqual([1000, 2000]);
  });

  test('stop() really stops, and start() is idempotent', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    let calls = 0;
    s.register({ key: 'k', intervalMs: 1000, fetch: async () => { calls += 1; return calls; } });
    s.start();
    s.start();
    await f.advance(1000);
    const afterStart = calls;
    expect(afterStart).toBe(2);
    s.stop();
    await f.advance(5000);
    expect(calls).toBe(afterStart);
  });
});

describe('subscribers', () => {
  test('a subscriber is told when the cache changes and can unsubscribe', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    s.register({ key: 'k', intervalMs: 1000, fetch: async () => 1 });
    let notified = 0;
    const off = s.subscribe('k', () => { notified += 1; });
    s.start();
    await f.advance(1000);
    expect(notified).toBe(2);
    off();
    await f.advance(1000);
    expect(notified).toBe(2);
    s.stop();
  });

  test('a throwing subscriber does not stop the others or the cadence', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    let calls = 0;
    s.register({ key: 'k', intervalMs: 1000, fetch: async () => { calls += 1; return calls; } });
    s.subscribe('k', () => { throw new Error('bad subscriber'); });
    let good = 0;
    s.subscribe('k', () => { good += 1; });
    s.start();
    await f.advance(1000);
    s.stop();
    expect(good).toBe(2);
    expect(calls).toBe(2);
  });
});


describe('cache and lifecycle regressions', () => {
  test('stopping between the timer and fetch microtask does not start a request', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    let calls = 0;
    s.register({ key: 'k', intervalMs: 1000, fetch: async () => ++calls });
    s.start();
    f.fireNext();
    s.stop();
    await settle();
    expect(calls).toBe(0);
    s.start();
    await f.advance(0);
    expect(calls).toBe(1);
    s.stop();
  });

  test('empty snapshots are stable before registration and across pure reads', () => {
    const s = new PublicFeedScheduler();
    expect(s.read('unknown')).toBe(s.read('unknown'));
    expect(s.read('unknown')).toBe(EMPTY_FEED_STATE);
    s.register({ key: 'unknown', intervalMs: 1000, fetch: async () => 1 });
    expect(s.read('unknown')).toBe(EMPTY_FEED_STATE);
  });

  test('every consecutive failure retains the successful data and its original timestamp', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    let calls = 0;
    const good = { assets: [1] };
    s.register({ key: 'k', intervalMs: 1000, fetch: async () => {
      if (++calls > 1) throw new Error('offline');
      return good;
    } });
    s.start();
    await f.advance(0);
    const ready = s.read('k');
    for (let i = 1; i <= 3; i += 1) {
      await f.advance(1000);
      const state = s.read('k');
      expect(feedData(state)).toBe(good);
      expect(state).toMatchObject({ status: 'error', dataAt: 0, at: i * 1000 });
    }
    expect(ready).toMatchObject({ status: 'ready', data: good, at: 0 });
    s.stop();
  });

  test('a synchronous throw is an error and does not kill subsequent grid ticks', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    const at: number[] = [];
    s.register({ key: 'k', intervalMs: 1000, fetch: () => {
      at.push(f.now());
      if (at.length < 3) throw new Error('synchronous failure');
      return Promise.resolve('recovered');
    } });
    s.start();
    await f.advance(2000);
    expect(at).toEqual([0, 1000, 2000]);
    expect(feedData(s.read('k'))).toBe('recovered');
    s.stop();
  });

  for (const reject of [false, true]) {
    test(`a late ${reject ? 'rejection' : 'resolution'} after stop cannot publish or strand inFlight`, async () => {
      const f = fakeClock();
      const s = new PublicFeedScheduler(f.clock);
      let finish!: () => void;
      let calls = 0;
      let notified = 0;
      s.subscribe('k', () => { notified += 1; });
      s.register({ key: 'k', intervalMs: 1000, fetch: () => {
        calls += 1;
        if (calls > 1) return Promise.resolve('new');
        return new Promise<string>((resolve, fail) => {
          finish = () => reject ? fail(new Error('old')) : resolve('old');
        });
      } });
      s.start();
      await f.advance(0);
      s.stop();
      finish();
      await settle();
      expect(s.read('k')).toBe(EMPTY_FEED_STATE);
      expect(notified).toBe(0);
      s.start();
      await f.advance(0);
      expect(calls).toBe(1);
      await f.advance(1000);
      expect(feedData(s.read('k'))).toBe('new');
      s.stop();
    });
  }

  test('a request left hanging by an earlier run no longer blocks the restarted run, and cannot publish', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    let finish!: () => void;
    let calls = 0;
    s.register({ key: 'k', intervalMs: 1000, fetch: () => {
      calls += 1;
      if (calls > 1) return Promise.resolve('new');
      return new Promise<string>((resolve) => { finish = () => resolve('old'); });
    } });
    s.start();
    await f.advance(0);
    s.stop();
    s.start();
    await f.advance(1000);
    // stop() abandons the hanging request: one that NEVER settles (a hung
    // connection has no timeout) must not silence its feed across a restart.
    expect(calls).toBe(2);
    expect(feedData(s.read('k'))).toBe('new');
    finish();
    await settle();
    // Its late resolution still cannot publish into the new run.
    expect(feedData(s.read('k'))).toBe('new');
    s.stop();
  });

  test('a late-settling abandoned request cannot remove a newer run\'s in-flight entry', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    let finishOld!: () => void;
    let finishNew!: () => void;
    let calls = 0;
    s.register({ key: 'k', intervalMs: 1000, fetch: () => {
      calls += 1;
      if (calls === 1) return new Promise<string>((resolve) => { finishOld = () => resolve('old'); });
      if (calls === 2) return new Promise<string>((resolve) => { finishNew = () => resolve('new'); });
      return Promise.resolve('later');
    } });
    s.start();
    await f.advance(0);
    s.stop();
    s.start();
    await f.advance(1000);
    finishOld();
    await settle();
    // The abandoned promise neither published nor deleted the new entry: the
    // next tick still deduplicates against the newer in-flight request.
    expect(s.read('k')).toBe(EMPTY_FEED_STATE);
    await f.advance(1000);
    expect(calls).toBe(2);
    finishNew();
    await settle();
    expect(feedData(s.read('k'))).toBe('new');
    s.stop();
  });

  test('StrictMode effect replay before bootstrap makes one request; later remounts stay on-grid', async () => {
    const f = fakeClock();
    f.setNow(123);
    const s = new PublicFeedScheduler(f.clock);
    const at: number[] = [];
    s.register({ key: 'k', intervalMs: 1000, fetch: async () => { at.push(f.now()); return 1; } });
    s.start();
    s.stop();
    s.start();
    await f.advance(0);
    expect(at).toEqual([123]);
    s.stop();
    f.setNow(200);
    s.start();
    await f.advance(0);
    expect(at).toEqual([123]);
    await f.advance(800);
    expect(at).toEqual([123, 1000]);
    s.stop();
  });

  test('idempotent registration does not cancel a pending bootstrap', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    let calls = 0;
    const feed = { key: 'k', intervalMs: 1000, fetch: async () => ++calls };
    s.register(feed);
    s.start();
    s.register(feed);
    await f.advance(0);
    expect(calls).toBe(1);
    s.stop();
  });

  test('late timers skip missed instants without a burst or a shifted grid', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    const at: number[] = [];
    s.register({ key: 'k', intervalMs: 1000, fetch: async () => { at.push(f.now()); return 1; } });
    s.start();
    await f.advance(0);
    f.setNow(3500);
    await f.advance(0);
    expect(at).toEqual([0, 3500]);
    await f.advance(500);
    expect(at).toEqual([0, 3500, 4000]);
    s.stop();
  });

  test('boundary arithmetic is positive and timer overflow intervals are refused', () => {
    const s = new PublicFeedScheduler();
    for (const period of [1, 1000, 60_000]) {
      for (const now of [0, 1, 999, 1000, 1000.5, 1789099200000]) {
        const delay = s.msUntilNextTick(period, now);
        expect(delay).toBeGreaterThan(0);
        expect(delay).toBeLessThanOrEqual(period);
        expect((now + delay) % period).toBe(0);
      }
    }
    for (const intervalMs of [0.5, Infinity, 2_147_483_648]) {
      expect(() => s.register({ key: 'bad', intervalMs, fetch: async () => 1 })).toThrow();
    }
  });
});

describe('nothing is fetched while nobody is using the tab', () => {
  function fakeActivity(initial: boolean) {
    let active = initial;
    const listeners = new Set<(a: boolean) => void>();
    return {
      signal: {
        isActive: () => active,
        subscribe: (fn: (a: boolean) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
      },
      set(next: boolean) {
        active = next;
        for (const fn of [...listeners]) fn(next);
      },
      listenerCount: () => listeners.size,
    };
  }

  test('inactive ticks are skipped; a feed without a max age resumes on the grid at return, no burst', async () => {
    const f = fakeClock();
    const a = fakeActivity(true);
    const s = new PublicFeedScheduler(f.clock, a.signal);
    const at: number[] = [];
    s.register({ key: 'k', intervalMs: 1000, fetch: async () => { at.push(f.now()); return 1; } });
    s.start();
    await f.advance(2000);
    expect(at).toEqual([0, 1000, 2000]);

    a.set(false);
    await f.advance(5000);
    // Five grid instants passed with nothing sent.
    expect(at).toEqual([0, 1000, 2000]);

    await f.advance(400);
    a.set(true);
    await settle();
    // No request at the moment the user came back, although ticks were
    // missed: only a feed with a max age refreshes at return...
    expect(at).toEqual([0, 1000, 2000]);
    await f.advance(1_600);
    // ...the next one is the next grid instant.
    expect(at).toEqual([0, 1000, 2000, 8000, 9000]);
    s.stop();
  });

  test('a page loaded with nobody looking bootstraps once when the user arrives', async () => {
    const f = fakeClock();
    f.setNow(10_250);
    const a = fakeActivity(false);
    const s = new PublicFeedScheduler(f.clock, a.signal);
    const at: number[] = [];
    s.register({ key: 'k', intervalMs: 1000, fetch: async () => { at.push(f.now()); return 1; } });
    s.start();
    await f.advance(3_000);
    expect(at).toEqual([]);
    expect(s.read('k')).toEqual({ status: 'empty' });

    a.set(true);
    await f.advance(0);
    expect(at).toEqual([13_250]);
    await f.advance(1_000);
    expect(at).toEqual([13_250, 14_000]);

    // Leaving and coming back again does not bootstrap a second time.
    a.set(false);
    await f.advance(3_000);
    a.set(true);
    await settle();
    expect(at).toEqual([13_250, 14_000]);
    s.stop();
  });

  test('coming back after more than the max age: the stale feed fetches once at return, then rejoins the grid; a fresh feed waits', async () => {
    // Review of #198: decisions older than their 180s bound blank the balance,
    // so waiting up to a period for the next instant brought back the
    // "Shielded balance unavailable" this work set out to remove.
    const f = fakeClock();
    const a = fakeActivity(true);
    const s = new PublicFeedScheduler(f.clock, a.signal);
    const decisions: number[] = [];
    const slow: number[] = [];
    s.register({ key: 'decisions', intervalMs: 60_000, maxAgeMs: 180_000, fetch: async () => { decisions.push(f.now()); return 1; } });
    // Fresh on return: a 10-minute feed last fetched under one period ago.
    s.register({ key: 'slow', intervalMs: 600_000, fetch: async () => { slow.push(f.now()); return 1; } });
    s.start();
    await f.advance(60_000);
    expect(decisions).toEqual([0, 60_000]);
    expect(slow).toEqual([0]);

    a.set(false);
    await f.advance(240_000); // inactive 4 minutes: decisions are 240s old
    expect(decisions).toEqual([0, 60_000]);

    await f.advance(10_000); // return off-grid, at 310_000
    a.set(true);
    await settle();
    expect(decisions).toEqual([0, 60_000, 310_000]);
    expect(slow).toEqual([0]);
    expect(s.read('decisions').status).toBe('ready');

    // Then back on the grid, with no second catch-up.
    await f.advance(110_000);
    expect(decisions).toEqual([0, 60_000, 310_000, 360_000, 420_000]);
    expect(slow).toEqual([0]);
    s.stop();
  });

  test('a short absence does not fetch at return when the data outlives the next instant', async () => {
    const f = fakeClock();
    const a = fakeActivity(true);
    const s = new PublicFeedScheduler(f.clock, a.signal);
    const at: number[] = [];
    s.register({ key: 'decisions', intervalMs: 60_000, maxAgeMs: 180_000, fetch: async () => { at.push(f.now()); return 1; } });
    s.start();
    await f.advance(60_000);
    a.set(false);
    await f.advance(30_000);
    a.set(true); // 30s old, next instant in 30s: 60s < 180s
    await f.advance(0);
    expect(at).toEqual([0, 60_000]);
    s.stop();
  });

  test('after a throttle only feeds with a max age refresh', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    const decisions: number[] = [];
    const other: number[] = [];
    let fail = false;
    s.register({ key: 'decisions', intervalMs: 60_000, maxAgeMs: 180_000, fetch: async () => { if (fail) throw new Error('Rate limit exceeded'); decisions.push(f.now()); return 1; } });
    s.register({ key: 'other', intervalMs: 60_000, fetch: async () => { if (fail) throw new Error('Rate limit exceeded'); other.push(f.now()); return 1; } });
    s.start();
    await f.advance(0);
    fail = true;
    await f.advance(150_000);
    fail = false;
    s.refreshStale();
    await f.advance(0);
    expect(decisions).toEqual([0, 150_000]);
    expect(other).toEqual([0]);
    s.stop();
  });

  test('window recovery retries missing proof inputs but leaves healthy slow feeds on their grid', async () => {
    const f = fakeClock();
    const s = new PublicFeedScheduler(f.clock);
    let failed = true;
    const calls: string[] = [];
    for (const key of ['key', 'set']) {
      s.register({ key, intervalMs: 60_000, retryMs: 15_000, fetch: async () => {
        calls.push(key);
        if (failed) throw new Error('ASP busy');
        return key;
      } });
    }
    s.register({ key: 'stats', intervalMs: 600_000, fetch: async () => { calls.push('stats'); return 1; } });
    s.start();
    await f.advance(0);
    expect(calls).toEqual(['key', 'set', 'stats']);
    failed = false;
    s.refreshStale();
    await f.advance(0);
    expect(calls).toEqual(['key', 'set', 'stats', 'key', 'set']);
    s.refreshStale();
    await f.advance(0);
    expect(calls).toHaveLength(5);
    s.stop();
  });

  test('stop() drops the activity subscription', () => {
    const f = fakeClock();
    const a = fakeActivity(true);
    const s = new PublicFeedScheduler(f.clock, a.signal);
    s.start();
    expect(a.listenerCount()).toBe(1);
    s.stop();
    expect(a.listenerCount()).toBe(0);
  });
});
