/**
 * One backoff for every request this client sends the ASP.
 *
 * WHY. The ASP rate-limits per IP and answers 403 {"message":"Rate limit
 * exceeded"} (or 429). Mike's prod session (2026-10-01) took 469 of those in
 * ten minutes, and the client answered each one by asking again: React Query
 * retried, the entrypoints cache refused to remember a failure, and every
 * caller refetched at once. The throttle never cleared, and the balance read
 * "Shielded balance unavailable" the whole time.
 *
 * WHAT. The first rate-limit answer opens a window in which ordinary ASP requests
 * fail at once with {@link AspBackoffError}, which
 * `isRateLimitError` recognises, so the existing "the ASP is rate limiting"
 * handling applies unchanged. The window starts at 60s and doubles each time
 * the first request after it is throttled again, up to {@link ASP_BACKOFF_MAX_MS}.
 * A fixed-grid probe can close it early; callers cannot claim a probe.
 *
 * Answers to requests sent BEFORE the window opened are ignored while it is
 * open: a burst of in-flight 403s is one strike, not twenty, and a late success
 * from before the throttle does not reopen the gate early.
 *
 * Pure module: the clock is injected. services/egress-fetch.ts owns the app's
 * single instance, since every ASP request in the app goes through it.
 */
import { abortReason } from '@/services/abort-signal';
import { isRateLimitError } from '@/services/rpc-log-chunking';
import { LABEL_DECISIONS_INTERVAL_MS, LABEL_DECISIONS_MAX_AGE_MS } from '@/services/label-decision-feed';

export const ASP_BACKOFF_BASE_MS = 60_000;

/**
 * The longest window. Short enough that the label decisions cannot go stale
 * from the backoff alone: a decision snapshot is at most one interval old when
 * a window opens, and the window's end refreshes it at once (public-feeds.ts
 * onWindowEnd), so interval + window stays under the decisions' max age with
 * 10s to spare. A longer window (it was 5 minutes) blanked every withdraw
 * balance for its tail even when the ASP's own throttle had long cleared.
 * Currently 110s: 60s, then 110s, 110s, ... while the ASP keeps throttling.
 */
export const ASP_BACKOFF_MAX_MS = Math.min(110_000, LABEL_DECISIONS_MAX_AGE_MS - LABEL_DECISIONS_INTERVAL_MS - 10_000);

/**
 * While a window is open, one fixed-grid probe of `/public-key` goes out this
 * often (services/public-feeds.ts, 'asp-backoff-probe'). Without recovery a
 * deposit started inside a window was refused for the whole window
 * (2026-10-15: "retrying in 109s") even when the ASP's own throttle had
 * already cleared. A probe that succeeds closes the window; one that is
 * throttled leaves it as it was (no extra strike). Callers never claim a
 * probe: a probe timed by a user action would leak that action. At most four
 * requests a minute reach a throttling ASP this way, none while healthy.
 */
export const ASP_BACKOFF_PROBE_MS = 15_000;

/**
 * Minimum spacing between ASP requests from this client. The ASP blocks an IP
 * for 5 minutes past 20 requests in one second (asp-v2 rate-limiter.service,
 * ipOnlyRateLimiter), and every feed of every chain lands on the same grid
 * instant, so with 7 chains a 10-minute instant (or the page-load bootstrap)
 * put ~80 requests on the wire at once. Spacing them keeps the grid (the set
 * and the instants are unchanged, a tick just drains over a few seconds) and
 * caps the burst under 7 a second, a third of the limit. One queue for every
 * chain and every feed, so a feed added per chain shares this budget instead
 * of adding its own burst. Recovery probes share it too.
 */
export const ASP_PACE_MS = 150;
/** A stalled/background tab must not retain an unlimited promise chain. */
export const ASP_MAX_PENDING = 128;

/**
 * A FIFO pacer: each caller is released at least `paceMs` after the previous
 * ACTUAL release, and its send runs inside that slot. Bounded and abortable.
 */
export function createAspPacer(opts: {
  now?: () => number;
  paceMs?: number;
  maxPending?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
} = {}) {
  // Monotonic time: changing the wall clock cannot shorten the release gap.
  const now = opts.now ?? (() => performance.now());
  const paceMs = opts.paceMs ?? ASP_PACE_MS;
  const setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  type Waiter = { release: () => void; reject: (error: unknown) => void; cleanup: () => void };
  const queue: Waiter[] = [];
  let timer: unknown;
  let lastReleased = -Infinity;
  const cancelTimer = () => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
  };
  const drain = () => {
    cancelTimer();
    if (!queue.length) return;
    const delay = lastReleased + paceMs - now();
    if (delay > 0) {
      timer = setTimer(drain, delay);
      return;
    }
    const next = queue.shift()!;
    next.cleanup();
    lastReleased = now();
    next.release();
    // A late timer releases just one request. No reserved slots can bunch up.
    if (queue.length) timer = setTimer(drain, paceMs);
  };
  const cancelPending = (error: unknown = new Error('ASP requests stopped')) => {
    cancelTimer();
    for (const waiter of queue.splice(0)) {
      waiter.cleanup();
      waiter.reject(error);
    }
  };
  function run<T>(send: () => T | Promise<T>, signal?: AbortSignal | null): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (queue.length >= (opts.maxPending ?? ASP_MAX_PENDING)) {
      return Promise.reject(new Error('ASP request queue is full; waiting for the next feed tick'));
    }
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        const index = queue.indexOf(waiter);
        if (index < 0) return;
        queue.splice(index, 1);
        waiter.cleanup();
        reject(abortReason(signal!));
        if (!queue.length) cancelTimer();
      };
      const waiter: Waiter = {
        release: () => { try { resolve(send()); } catch (error) { reject(error); } },
        reject,
        cleanup: () => signal?.removeEventListener('abort', abort),
      };
      signal?.addEventListener('abort', abort, { once: true });
      queue.push(waiter);
      if (timer === undefined) drain();
    });
  }
  return {
    // Invoke fetch IN the release slot. Resolving a permit first could let a
    // busy microtask delay its fetch until the next permit is already due.
    run,
    wait: (signal?: AbortSignal | null) => run(() => undefined, signal),
    cancelPending,
    reset: () => { cancelPending(); lastReleased = -Infinity; },
  };
}

export class AspBackoffError extends Error {
  /** isRateLimitError reads `status`; 429 is what this stands in for. */
  readonly status = 429;

  constructor(readonly retryInMs: number) {
    super(`ASP rate limit exceeded, retrying in ${Math.ceil(retryInMs / 1000)}s`);
    this.name = 'AspBackoffError';
  }
}

/**
 * The user-facing sentence for an ASP throttle, or null when `text` is not
 * one. Matches the backoff's own refusal and the ASP's 403/429 as APIClient
 * reports them, never the relayer's 429 (that has its own wording). The wait
 * comes from the message, else from `fallbackMs` (the live window).
 */
export function aspBusyMessage(text: string, fallbackMs = 0): string | null {
  const ours = /ASP rate limit exceeded|API request failed: 429 Rate limit exceeded/i.test(text);
  // APIClient's report, or the SDK adapter's (FetchHTTPClient: "HTTP 403: ...
  // {"message":"Rate limit exceeded"}"). The relayer's 429 says "Too Many
  // Requests", so it does not match.
  const theirs = /API request failed: 40[39]\b[^(]*rate limit exceeded/i.test(text)
    || /\bHTTP 403\b[\s\S]*rate limit exceeded/i.test(text);
  if (!ours && !theirs) return null;
  const quoted = /retrying in (\d+)s/i.exec(text);
  const seconds = quoted ? Number(quoted[1]) : Math.ceil(fallbackMs / 1000);
  return seconds > 0 ? `The ASP is busy. Try again in ${seconds}s.` : 'The ASP is busy. Try again in a minute.';
}

export type AspProbe = { window: number };
export type AspBackoff = ReturnType<typeof createAspBackoff>;

export function createAspBackoff(opts: {
  now?: () => number;
  baseMs?: number;
  maxMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
} = {}) {
  const setTimer = opts.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const listeners = new Set<() => void>();
  const startListeners = new Set<() => void>();
  let endTimer: unknown;
  const cancelEnd = () => {
    if (endTimer !== undefined) clearTimer(endTimer);
    endTimer = undefined;
  };
  const now = opts.now ?? (() => Date.now());
  const baseMs = opts.baseMs ?? ASP_BACKOFF_BASE_MS;
  const maxMs = opts.maxMs ?? ASP_BACKOFF_MAX_MS;
  let openedAt = 0;
  let until = 0;
  let strikes = 0;
  let window = 0;
  let probe: AspProbe | undefined;
  let nextProbeAt = 0;
  let paused = false;
  let notified = true;
  const notify = (callbacks: Set<() => void>) => {
    for (const listener of [...callbacks]) {
      try { listener(); } catch { /* A listener cannot stop recovery. */ }
    }
  };
  const notifyEnd = () => {
    if (notified) return;
    notified = true;
    notify(listeners);
  };
  const blockedForMs = () => Math.max(0, until - now());
  const scheduleEnd = () => {
    cancelEnd();
    if (paused || notified) return;
    endTimer = setTimer(() => {
      endTimer = undefined;
      // A backward wall-clock adjustment must not announce an open gate.
      if (blockedForMs() > 0) scheduleEnd();
      else notifyEnd();
    }, blockedForMs());
  };
  const isStale = (sentAt: number) => sentAt < openedAt || sentAt < until;
  const close = () => {
    strikes = 0;
    until = 0;
    probe = undefined;
    cancelEnd();
    if (!paused) notifyEnd();
  };
  return {
    now,
    blockedForMs,
    assertOpen: () => {
      const left = blockedForMs();
      if (left > 0) throw new AspBackoffError(left);
    },
    /** Called only by the fixed-grid probe, never by ordinary requests. */
    beginProbe: (): AspProbe | undefined => {
      if (paused || blockedForMs() <= 0 || probe || now() < nextProbeAt) return;
      nextProbeAt = now() + ASP_BACKOFF_PROBE_MS;
      probe = { window };
      return probe;
    },
    isCurrentProbe: (ticket: AspProbe) => ticket === probe && ticket.window === window && blockedForMs() > 0,
    finishProbe: (ticket: AspProbe, success: boolean) => {
      if (ticket !== probe || ticket.window !== window) return;
      probe = undefined;
      if (success && blockedForMs() > 0) close();
    },
    recordRateLimited: (sentAt: number) => {
      if (isStale(sentAt)) return;
      strikes += 1;
      window += 1;
      probe = undefined;
      openedAt = now();
      until = openedAt + Math.min(maxMs, baseMs * 2 ** (strikes - 1));
      nextProbeAt = 0;
      notified = false;
      scheduleEnd();
      notify(startListeners);
    },
    recordSuccess: (sentAt: number) => {
      if (!isStale(sentAt)) close();
    },
    onWindowStart: (listener: () => void) => {
      startListeners.add(listener);
      return () => { startListeners.delete(listener); };
    },
    /** Both natural expiry and a successful current-window probe notify once. */
    onWindowEnd: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    pause: () => { paused = true; cancelEnd(); },
    resume: () => { paused = false; scheduleEnd(); },
    reset: () => {
      cancelEnd();
      window += 1;
      probe = undefined;
      openedAt = 0;
      until = 0;
      strikes = 0;
      nextProbeAt = 0;
      notified = true;
      paused = false;
    },
  };
}

/**
 * Is this ASP answer the throttle? 429 always; 403 only when the body says so,
 * since a 403 is also how the ASP refuses an unknown pool.
 */
export function isAspRateLimitResponse(status: number, body: string | null): boolean {
  if (status === 429) return true;
  return status === 403 && body !== null && isRateLimitError(body);
}

/** Read a rate-limit verdict off a Response without consuming its body. */
export async function responseIsRateLimit(response: Response): Promise<boolean> {
  if (response.status === 429) return true;
  if (response.status !== 403) return false;
  let body: string | null = null;
  try {
    body = await response.clone().text();
  } catch {
    body = null;
  }
  return isAspRateLimitResponse(response.status, body);
}
