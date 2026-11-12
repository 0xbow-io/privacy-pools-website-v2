/**
 * One place that fetches public data, on a cadence nothing the user does can
 * change.
 *
 * WHY
 *
 * Step 1 checks observed traffic for a journey; step 2 refuses a request whose
 * CONTENT is not allowed. Neither addresses the channel that is left: *when*
 * you ask, and *what set* of things you ask for. Both are visible to the ASP
 * without a single forbidden byte crossing the wire.
 *
 *   TIMING — a request that only happens when a withdrawal is imminent
 *   announces the withdrawal by existing. This is the half of the 2026-09-10
 *   disclosure that no payload rule can catch, and it is why the fix for the
 *   amount lookup was not "send a safer amount" but "fetch it at page load,
 *   with everything else".
 *
 *   SILENCE — the same channel inverted, and the one this module was written
 *   after finding. Several remaining public feeds are gated `refetchInterval:
 *   txPending ? false : N`, so the moment a deposit, transfer, withdrawal or
 *   ragequit begins, this client stops talking to the ASP, and it starts again
 *   when the transaction settles. A server watching a connection sees a clean
 *   40-second hole that brackets an on-chain event. That is the original join
 *   — "this session did the thing that happened at T" — obtained without
 *   sending anything at all.
 *
 *   SET — which feeds a client fetches reveals which screens it opened.
 *   Fetching the yield feeds only on the portfolio tab says the user is on the
 *   portfolio tab. A feed registered here is attempted by every client that
 *   loads the app, whatever it then does. (Attempted, not achieved: a fetch
 *   slower than its period skips ticks rather than queueing, so request COUNT
 *   still varies with network speed — set membership is what stops varying.)
 *
 * SO THE RULES ARE
 *
 *   1. The set of public feeds is STATIC, declared in one list. Not derived
 *      from which components mounted.
 *   2. The cadence targets a fixed WALL-CLOCK GRID in each client's clock.
 *      It does not retain page-arrival phase or choose a persistent random
 *      offset. Clock skew and scheduling delay still distinguish clients.
 *      Independent per-request jitter is not a persistent client identifier,
 *      either; avoiding it here is a scheduling choice, not an anonymity proof.
 *   3. Nothing the user does INSIDE THE APP changes any of it. Not opening a
 *      form, not having a transaction in flight. Two user actions do move it
 *      by moving the PLATFORM, and an observer can see both: loading the page
 *      fires the off-grid bootstrap, and hiding the tab lets the browser
 *      throttle or suspend these timers — so visibility still shifts ticks.
 *   4. The UI can READ the cache and can never cause a fetch. `readFeed` is
 *      pure; there is no `refetch`. A component with no data yet renders a
 *      loading state, which is the honest thing for data it is not allowed to
 *      demand.
 *
 * WHAT IT DOES NOT DO
 *
 * A fixed cadence does not hide that this IP uses the app, or when it had the
 * page open. The off-grid bootstrap deliberately reveals arrival time for
 * usable first paint. For the migrated feeds, app state no longer schedules
 * requests. This does not make clients indistinguishable: local clock skew,
 * network delay, background throttling, suspension and proof work blocking
 * the JS thread can shift or suppress ticks. Other feeds remain unmigrated,
 * and the remaining react-query polls DO refetch on window focus (the TanStack
 * default), so focusing the tab still causes requests — just not from here.
 * Synchronization also concentrates server load at grid boundaries; capacity
 * and caching need to account for that. Stronger traffic-analysis protection
 * needs shared infrastructure and an evaluated threat model.
 *
 * A zero-argument fetch is an API constraint, not a proof of public content:
 * closures can still capture user state. Review the static definitions too.
 *
 * INACTIVE TABS (2026-10-01). Grid instants pass without a request while
 * nobody is using the tab (services/activity-signal.ts: hidden, frozen, or
 * unfocused with no input for five minutes). The grid keeps its phase, so a
 * returning user's first request lands on the next normal instant. This is
 * the third platform-level move under rule 3, and the same kind: it says
 * someone is or is not at the tab, never what they are doing in it.
 */
import { activitySignal, ALWAYS_ACTIVE, type ActivitySignal } from '@/services/activity-signal';

export type PublicFeedKey = string;

export type PublicFeedDefinition<T = unknown> = {
  key: PublicFeedKey;
  /**
   * Grid period, in integer milliseconds within the setTimeout range. Clients
   * with equal clocks target the same instants regardless of arrival time.
   */
  intervalMs: number;
  /**
   * How old this feed's data may get before a consumer stops trusting it
   * (the label decisions refuse a spend past theirs). Used only when a skipped
   * stretch ends (the tab becomes active again, or the ASP backoff closes):
   * a feed whose data would be past this before its next grid instant is
   * fetched once at that moment. Feeds without one just wait for their next instant.
   */
  maxAgeMs?: number;
  /**
   * Grid period while the feed holds no data at all, for a feed whose
   * consumers fail outright without it. A first fetch that fails is retried on
   * this shorter grid until one succeeds, then the feed returns to
   * `intervalMs`. A feed holding data keeps its normal cadence whatever its
   * refreshes do. Still a wall-clock grid, so the retries say nothing about the
   * user. A throttled ASP retry never leaves the browser: the ASP backoff
   * (services/asp-backoff.ts) refuses it locally until its window ends. Must
   * divide `intervalMs`.
   */
  retryMs?: number;
  /**
   * Also use `retryMs` after a failed REFRESH (the feed holds older data), not
   * only before the first success. For a feed whose consumers stop trusting
   * the data once it ages out, e.g. the keystore registries a write waits on.
   * Same wall-clock grid, so it still says nothing about the user.
   */
  retryOnError?: boolean;
  /**
   * Fetch the feed. Takes NO arguments on purpose: a public feed is the same
   * for everyone, and a parameter is how it stops being one.
   */
  fetch: () => Promise<T>;
};

export type FeedState<T = unknown> =
  | { status: 'empty' }
  | { status: 'ready'; data: T; at: number }
  | { status: 'error'; error: Error; at: number; data?: T; dataAt?: number };

// Unknown feeds are read during render, before the root effect registers them.
// useSyncExternalStore requires the same object until the store changes.
export const EMPTY_FEED_STATE = Object.freeze({ status: 'empty' } as const);

type Listener = () => void;

type Clock = {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The scheduler, as a class so tests can build one with a fake clock instead
 * of reaching into module state. The app uses the single instance below.
 */
export class PublicFeedScheduler {
  private readonly feeds = new Map<PublicFeedKey, PublicFeedDefinition>();

  private readonly states = new Map<PublicFeedKey, FeedState>();

  private readonly listeners = new Map<PublicFeedKey, Set<Listener>>();

  private readonly timers = new Map<PublicFeedKey, unknown>();

  private readonly inFlight = new Map<PublicFeedKey, Promise<void>>();

  private running = false;

  private generation = 0;

  private readonly attempted = new Set<PublicFeedKey>();

  private unsubscribeActivity: (() => void) | null = null;

  /**
   * @param activity whether anyone is using the tab (services/activity-signal.ts).
   *   While inactive, grid instants pass without a request; the grid itself
   *   keeps its phase, so the first request after the user returns lands on
   *   the next normal instant, with no catch-up burst. That is a presence
   *   signal (the ASP sees an idle tab go quiet), never a funds signal.
   */
  constructor(
    private readonly clock: Clock = realClock,
    private readonly activity: ActivitySignal = ALWAYS_ACTIVE,
  ) {}

  /**
   * Declare a feed. Registration is expected at module load, from one list, so
   * the set of requests a client makes is a property of the BUILD and not of
   * the session.
   */
  register<T>(feed: PublicFeedDefinition<T>): void {
    if (!Number.isInteger(feed.intervalMs) || feed.intervalMs < 1 || feed.intervalMs > 2_147_483_647) {
      throw new Error(`Feed '${feed.key}' needs an integer intervalMs between 1 and 2147483647`);
    }
    if (feed.retryMs !== undefined && (!Number.isInteger(feed.retryMs) || feed.retryMs < 1
      || feed.retryMs >= feed.intervalMs || feed.intervalMs % feed.retryMs !== 0)) {
      throw new Error(`Feed '${feed.key}' needs an integer retryMs that divides its intervalMs`);
    }
    const existing = this.feeds.get(feed.key);
    if (existing && existing !== (feed as PublicFeedDefinition)) {
      throw new Error(`Feed '${feed.key}' is already registered`);
    }
    if (existing) return;
    this.feeds.set(feed.key, feed as PublicFeedDefinition);
    if (!this.states.has(feed.key)) this.states.set(feed.key, EMPTY_FEED_STATE);
    if (this.running) this.schedule(feed.key);
  }

  registered(): PublicFeedKey[] {
    return [...this.feeds.keys()];
  }

  /**
   * Read the cache. Pure: it never starts a request, which is the property
   * that makes a component unable to leak by rendering.
   */
  read<T>(key: PublicFeedKey): FeedState<T> {
    return (this.states.get(key) as FeedState<T> | undefined) ?? EMPTY_FEED_STATE;
  }

  subscribe(key: PublicFeedKey, listener: Listener): () => void {
    const set = this.listeners.get(key) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(key, set);
    return () => {
      set.delete(listener);
    };
  }

  /** Begin the fixed cadence. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.unsubscribeActivity = this.activity.subscribe((active) => {
      if (active) this.refreshStale();
    });
    for (const key of this.feeds.keys()) {
      this.schedule(key, { immediate: !this.attempted.has(key) });
    }
  }

  /**
   * End of a skipped stretch: the tab became active again, or the ASP backoff
   * window closed. One pass, and only feeds that need it:
   *   - never attempted (a page that loaded in a background tab skipped its
   *     bootstrap): fetched now, once;
   *   - retrying a failed first load of a proof input (ASP key/set);
   *   - declaring a max age (the label decisions) and holding data that is,
   *     or would be before its next grid instant, past it, or holding none:
   *     fetched once now;
   *   - everything else waits for
   *     its next instant. A burst of every feed at once is what trips the
   *     ASP's per-IP throttle, so a return costs a couple of requests at most.
   * The grid timers are untouched, so every feed rejoins its normal instants.
   * The trigger is the platform (presence, or the server's throttle ending),
   * never anything the user does inside the app. Not a refetch door for the
   * UI: nothing in components calls it.
   */
  refreshStale(): void {
    if (!this.running || !this.activity.isActive()) return;
    const now = this.clock.now();
    for (const [key, feed] of this.feeds) {
      if (this.inFlight.has(key)) continue;
      if (!this.attempted.has(key)) {
        this.schedule(key, { immediate: true });
        continue;
      }
      const state = this.states.get(key);
      // A failed bootstrap of proof inputs (key/set) needs recovery too.
      // There is no UI trigger here: only activity/window-end invokes this.
      if (feed.retryMs !== undefined && feedData(state ?? EMPTY_FEED_STATE) === undefined) {
        void this.run(key);
        continue;
      }
      if (feed.maxAgeMs === undefined) continue;
      const at = state?.status === 'ready' ? state.at : state?.status === 'error' ? state.dataAt : undefined;
      if (at === undefined || now - at + this.msUntilNextTick(feed.intervalMs, now) >= feed.maxAgeMs) {
        void this.run(key);
      }
    }
  }

  stop(): void {
    this.running = false;
    this.generation += 1;
    this.unsubscribeActivity?.();
    this.unsubscribeActivity = null;
    for (const handle of this.timers.values()) this.clock.clearTimeout(handle);
    this.timers.clear();
    // Abandon in-flight requests too. The generation bump already bars them
    // from publishing; keeping the entries would let a request that NEVER
    // settles (a hung connection has no timeout here) block every future run()
    // of its feed across a stop/start, silencing it permanently. The finally
    // in run() deletes by identity, so a late-settling old promise cannot
    // remove a newer run's entry.
    this.inFlight.clear();
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Milliseconds until the next grid instant.
   *
   * Strictly future, not relative to when this client started:
   * `next = (floor(now / p) + 1) * p`. At an exact boundary, wait a full
   * period. A late timer skips missed boundaries without a catch-up burst.
   */
  msUntilNextTick(intervalMs: number, now = this.clock.now()): number {
    const next = (Math.floor(now / intervalMs) + 1) * intervalMs;
    return next - now;
  }

  private schedule(key: PublicFeedKey, opts: { immediate?: boolean } = {}): void {
    const feed = this.feeds.get(key);
    if (!feed || !this.running) return;
    const existing = this.timers.get(key);
    if (existing !== undefined) this.clock.clearTimeout(existing);
    // Bootstrap once per feed for first paint. This exposes arrival time, an
    // explicit tradeoff. Effect remounts after an attempt resume on the grid
    // instead of adding another off-grid fetch. A cancelled bootstrap that
    // never ran can still be attempted after a StrictMode effect replay.
    const delay = opts.immediate ? 0 : this.msUntilNextTick(this.periodOf(key, feed));
    const generation = this.generation;
    this.timers.set(
      key,
      this.clock.setTimeout(() => {
        if (!this.running || this.generation !== generation) return;
        this.timers.delete(key);
        // Nobody using the tab: let this instant pass, keep the grid.
        if (this.activity.isActive()) void this.run(key);
        this.schedule(key);
      }, delay),
    );
  }

  private periodOf(key: PublicFeedKey, feed: PublicFeedDefinition): number {
    if (feed.retryMs === undefined) return feed.intervalMs;
    const state = this.read(key);
    if (feed.retryOnError && state.status === 'error') return feed.retryMs;
    return feedData(state) === undefined ? feed.retryMs : feed.intervalMs;
  }

  private run(key: PublicFeedKey): Promise<void> {
    const feed = this.feeds.get(key);
    if (!feed || !this.running) return Promise.resolve();
    // A slow feed must not stack up requests: one in flight per feed. The grid
    // keeps ticking, so a feed that takes longer than its period simply skips
    // instants rather than queueing a burst that would stand out.
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const generation = this.generation;
    // A nominally Promise-returning callback can still throw synchronously.
    // Start it inside the chain so that failure cannot kill the timer loop.
    const promise = Promise.resolve()
      .then(() => {
        if (!this.running || this.generation !== generation) return;
        this.attempted.add(key);
        return feed.fetch();
      })
      .then((data) => {
        if (!this.running || this.generation !== generation) return;
        const retrying = this.periodOf(key, feed) !== feed.intervalMs;
        this.set(key, { status: 'ready', data, at: this.clock.now() });
        // The first data ends the retries: the pending instant is on the
        // retry grid, so move it to the normal one.
        if (retrying) this.schedule(key);
      })
      .catch((err: unknown) => {
        if (!this.running || this.generation !== generation) return;
        const error = err instanceof Error ? err : new Error(String(err));
        const previous = this.states.get(key);
        // Keep the last good value alongside the error: a failed refresh must
        // not blank a screen, and it must not tempt a caller into retrying on
        // its own schedule, which is exactly the timing channel this closes.
        this.set(key, {
          status: 'error',
          error,
          at: this.clock.now(),
          ...(previous?.status === 'ready' ? { data: previous.data, dataAt: previous.at } : {}),
          ...(previous?.status === 'error' ? { data: previous.data, dataAt: previous.dataAt } : {}),
        });
        // Opted-in feeds move the pending instant onto the retry grid.
        if (feed.retryOnError && feed.retryMs !== undefined) this.schedule(key);
      })
      .finally(() => {
        // Identity, not presence: after a stop() the entry may belong to a
        // request started by a LATER run, which this stale promise must not
        // delete.
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  private set(key: PublicFeedKey, state: FeedState): void {
    this.states.set(key, state);
    for (const listener of this.listeners.get(key) ?? []) {
      try {
        listener();
      } catch {
        /* a bad subscriber must not stop the others or the cadence */
      }
    }
  }
}

/**
 * The last good value, whether or not the most recent refresh failed.
 *
 * A failed refresh must not blank a screen, and it must especially not tempt a
 * caller into retrying on its own schedule — a retry loop keyed to what the
 * user is doing is the timing channel the scheduler exists to close. Callers
 * render this and, separately, may show that the data is stale.
 */
export function feedData<T>(state: FeedState<T>): T | undefined {
  if (state.status === 'ready') return state.data;
  if (state.status === 'error') return state.data;
  return undefined;
}

/** The app's single scheduler, quiet while nobody is using the tab. */
export const publicFeeds = new PublicFeedScheduler(realClock, activitySignal());
