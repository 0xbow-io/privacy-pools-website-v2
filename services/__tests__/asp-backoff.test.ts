import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

import * as backoffModule from '@/services/asp-backoff';
import * as egressFetch from '@/services/egress-fetch';
import * as policy from '@/services/egress-policy';
import * as entrypointsNormalize from '@/services/entrypoints-normalize';

import {
  ASP_BACKOFF_BASE_MS,
  ASP_BACKOFF_MAX_MS,
  AspBackoffError,
  aspBusyMessage,
  createAspBackoff,
  createAspPacer,
  ASP_PACE_MS,
  ASP_MAX_PENDING,
  isAspRateLimitResponse,
} from '@/services/asp-backoff';
import { aspBackoff, aspPacer, policedFetch, createEgressFetch } from '@/services/egress-fetch';
import { getEgressMode, setEgressMode } from '@/services/egress-policy';
import { isRateLimitError } from '@/services/rpc-log-chunking';
import { LABEL_DECISIONS_INTERVAL_MS, LABEL_DECISIONS_MAX_AGE_MS } from '@/services/label-decision-feed';

const ASP = 'https://asp.example';

// The real APIClient, with only its native config module replaced (same
// approach as egress-policy-coverage.test.ts; config/env cannot load in bun).
function loadApi() {
  const exports: Record<string, unknown> = {};
  const source = readFileSync(join(new URL('.', import.meta.url).pathname, '..', 'api-client.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const modules: Record<string, unknown> = {
    '@/config/env': { ASP_URL: ASP, LEGACY_CONFIG: undefined },
    '@/services/egress-policy': policy,
    '@/services/egress-fetch': egressFetch,
    '@/services/asp-backoff': backoffModule,
    '@/services/entrypoints-normalize': entrypointsNormalize,
  };
  const require = (name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected APIClient dependency: ${name}`);
    return modules[name];
  };
  new Function('require', 'exports', code)(require, exports);
  return exports as {
    APIClient: typeof import('@/services/api-client').APIClient;
    ENTRYPOINTS_GRID_MS: number;
    ENTRYPOINTS_TTL_MS: number;
  };
}
const THROTTLE = () => new Response(JSON.stringify({ message: 'Rate limit exceeded', error: 'Forbidden', statusCode: 403 }), { status: 403 });

describe('the backoff window', () => {
  test('a rate limit opens a 60s window, doubling per repeat up to the cap', () => {
    let now = 1_000_000;
    const b = createAspBackoff({ now: () => now });
    expect(b.blockedForMs()).toBe(0);

    b.recordRateLimited(now);
    expect(b.blockedForMs()).toBe(ASP_BACKOFF_BASE_MS);
    expect(() => b.assertOpen()).toThrow('ASP rate limit exceeded');

    const windows: number[] = [ASP_BACKOFF_BASE_MS];
    for (let i = 0; i < 6; i += 1) {
      now += b.blockedForMs();
      expect(b.blockedForMs()).toBe(0);
      // The first request after the window is throttled again.
      b.recordRateLimited(now);
      windows.push(b.blockedForMs());
    }
    // Capped at 110s so the label decisions cannot go stale from the backoff alone.
    expect(windows).toEqual([60_000, 110_000, 110_000, 110_000, 110_000, 110_000, 110_000]);
    expect(Math.max(...windows)).toBe(ASP_BACKOFF_MAX_MS);
  });

  test('the first success closes the window and resets the doubling', () => {
    let now = 0;
    const b = createAspBackoff({ now: () => now });
    b.recordRateLimited(now);
    now += 60_000;
    b.recordRateLimited(now); // 110s
    now += 110_000;
    b.recordSuccess(now);
    expect(b.blockedForMs()).toBe(0);
    b.recordRateLimited(now);
    expect(b.blockedForMs()).toBe(60_000);
  });

  test('answers to requests sent before the window opened do not move it', () => {
    let now = 0;
    const b = createAspBackoff({ now: () => now });
    const burstSentAt = now;
    b.recordRateLimited(burstSentAt);
    now += 200;
    // Twenty in-flight 403s from the same burst are one strike, not twenty.
    for (let i = 0; i < 20; i += 1) b.recordRateLimited(burstSentAt);
    expect(b.blockedForMs()).toBe(60_000 - 200);
    // And a late success from before the throttle does not reopen the gate.
    b.recordSuccess(burstSentAt);
    expect(b.blockedForMs()).toBe(60_000 - 200);
  });

  test('a window that runs out tells its listeners once; a cancelled one does not', () => {
    let now = 0;
    const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
    const b = createAspBackoff({
      now: () => now,
      setTimeout: (fn, ms) => { const t = { at: now + ms, fn, live: true }; timers.push(t); return t; },
      clearTimeout: (t) => { (t as { live: boolean }).live = false; },
    });
    let ends = 0;
    b.onWindowEnd(() => { ends += 1; });
    const fire = () => { for (const t of timers) if (t.live && t.at <= now) { t.live = false; t.fn(); } };

    b.recordRateLimited(now);
    now += 59_999; fire();
    expect(ends).toBe(0);
    now += 1; fire();
    expect(ends).toBe(1);

    b.recordRateLimited(now); // 110s window
    now += 109_999; fire();
    expect(ends).toBe(1);
    now += 1; fire();
    expect(ends).toBe(2);

    // A reset (or an early close) cancels the pending notice.
    b.recordRateLimited(now);
    b.reset();
    now += 600_000; fire();
    expect(ends).toBe(2);
  });

  test('the longest window cannot age the label decisions past their bound', () => {
    expect(LABEL_DECISIONS_INTERVAL_MS + ASP_BACKOFF_MAX_MS).toBeLessThan(LABEL_DECISIONS_MAX_AGE_MS);
  });

  test('withdraw copy: the ASP throttle reads as busy with the wait; the relayer 429 does not', () => {
    expect(aspBusyMessage(new AspBackoffError(42_100).message)).toBe('The ASP is busy. Try again in 43s.');
    expect(aspBusyMessage('API request failed: 429 Rate limit exceeded, retrying in 30s (https://api-v2.0xbow.io/association-set/leaves)'))
      .toBe('The ASP is busy. Try again in 30s.');
    expect(aspBusyMessage('API request failed: 403 Forbidden: Rate limit exceeded (https://api-v2.0xbow.io/labels/rejected)', 12_000))
      .toBe('The ASP is busy. Try again in 12s.');
    expect(aspBusyMessage('HTTP 403: Forbidden: {"message":"Rate limit exceeded","statusCode":403}'))
      .toBe('The ASP is busy. Try again in a minute.');
    expect(aspBusyMessage('Fast Relay: HTTP 429: {"statusCode":429,"message":"ThrottlerException: Too Many Requests"}')).toBeNull();
    expect(aspBusyMessage('API request failed: 403 Forbidden (https://api-v2.0xbow.io/x)')).toBeNull();
  });

  test('the error it throws is a rate limit to the rest of the app', () => {
    expect(isRateLimitError(new AspBackoffError(30_000))).toBe(true);
    expect(new AspBackoffError(30_000).message).toContain('30s');
  });

  test('a 403 is the throttle only when its body says so', () => {
    expect(isAspRateLimitResponse(429, null)).toBe(true);
    expect(isAspRateLimitResponse(403, '{"message":"Rate limit exceeded","statusCode":403}')).toBe(true);
    // The ASP's stricter limit on its heavier routes.
    expect(isAspRateLimitResponse(403, '{"message":"Rate limit exceeded for intensive operations"}')).toBe(true);
    expect(isAspRateLimitResponse(403, '{"message":"Forbidden"}')).toBe(false);
    // A 401 is the strict guard refusing for another reason, never the throttle.
    expect(isAspRateLimitResponse(401, '{"message":"Unauthorized","statusCode":401}')).toBe(false);
    expect(isAspRateLimitResponse(403, null)).toBe(false);
    expect(isAspRateLimitResponse(500, 'rate limit')).toBe(false);
  });
});

describe('policedFetch: no ASP request leaves during the window', () => {
  let previousMode: ReturnType<typeof getEgressMode>;
  beforeAll(() => { previousMode = getEgressMode(); setEgressMode('enforce'); });
  afterAll(() => setEgressMode(previousMode));
  afterEach(() => { aspBackoff.reset(); aspPacer.reset(); });

  test('after one throttle answer, every ASP call fails at once and nothing is sent', async () => {
    let sent = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { sent += 1; return THROTTLE(); }) as typeof fetch;
    try {
      const first = await policedFetch('asp', ASP, `${ASP}/public-key`);
      // The caller still gets the server's own answer for the request that went out.
      expect(first.status).toBe(403);
      expect(await first.json()).toEqual({ message: 'Rate limit exceeded', error: 'Forbidden', statusCode: 403 });
      expect(sent).toBe(1);
      for (let i = 0; i < 10; i += 1) {
        const err = await policedFetch('asp', ASP, `${ASP}/public-key`).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AspBackoffError);
        expect(isRateLimitError(err)).toBe(true);
      }
      expect(sent).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('the relayer is not affected by the ASP window', async () => {
    let sent = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { sent += 1; return THROTTLE(); }) as typeof fetch;
    try {
      await policedFetch('asp', ASP, `${ASP}/public-key`);
      globalThis.fetch = (async () => { sent += 1; return Response.json({}); }) as typeof fetch;
      await policedFetch('relayer', 'https://relayer.example', 'https://relayer.example/v1/details');
      expect(sent).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  test('APIClient: a throttle fails every later call as a 429 without sending, and entrypoints remember their last answer', async () => {
    const api = new (loadApi().APIClient)();
    const ENTRYPOINTS = { pools: [{ poolId: 'p', chainId: '1', entrypoint: '0xCA1E072236D231130059eeA6Bfceb7F4e9a1F0C3' }] };
    const sent: string[] = [];
    let throttle = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      sent.push(String(input));
      return throttle ? THROTTLE() : Response.json(String(input).includes('entrypoints') ? ENTRYPOINTS : { labels: [] });
    }) as typeof fetch;
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      expect((await api.getEntrypoints()).pools).toHaveLength(1);
      // The entrypoint goes out in one spelling, lowercase.
      await api.getRejectedLabels('1', ENTRYPOINTS.pools[0].entrypoint);
      expect(sent[1]).toContain('entrypoint=0xca1e072236d231130059eea6bfceb7f4e9a1f0c3');

      throttle = true;
      now += 6 * 60_000; // past the entrypoints TTL
      // The refresh is throttled; the caller still gets the last good answer.
      expect((await api.getEntrypoints()).pools).toHaveLength(1);
      expect(sent).toHaveLength(3);
      // Inside the window: refused locally, as a rate limit, nothing sent.
      const err = await api.getRejectedLabels('1').catch((e: unknown) => e);
      expect(isRateLimitError(err)).toBe(true);
      expect((err as { statusCode?: number }).statusCode).toBe(429);
      expect((await api.getEntrypoints()).pools).toHaveLength(1);
      expect(sent).toHaveLength(3);
    } finally {
      globalThis.fetch = original;
      Date.now = realNow;
    }
  });

  test('APIClient: entrypoints are fetched on the grid only, every other caller reads the copy (PR #254 e2e)', async () => {
    const mod = loadApi();
    const api = new mod.APIClient();
    // The copy outlives the grid period, or a tick can find it still fresh,
    // skip, and leave the fetch to the next caller (a discovery pass, a form).
    expect(mod.ENTRYPOINTS_TTL_MS).toBeGreaterThan(mod.ENTRYPOINTS_GRID_MS);
    const ENTRYPOINTS = { pools: [{ poolId: 'p', chainId: '1', entrypoint: '0xCA1E072236D231130059eeA6Bfceb7F4e9a1F0C3' }] };
    let sent = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { sent += 1; return Response.json(ENTRYPOINTS); }) as typeof fetch;
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      await api.getEntrypoints({ refresh: true });
      expect(sent).toBe(1);
      for (let tick = 1; tick <= 3; tick += 1) {
        // Just before the next tick, the copy is a hair under the period old,
        // and a caller off the grid still reads it.
        now += mod.ENTRYPOINTS_GRID_MS - 5;
        await api.getEntrypoints();
        // A late timer: the tick lands just after a full period.
        now += 10;
        await api.getEntrypoints();
        expect(sent).toBe(tick);
        await api.getEntrypoints({ refresh: true });
        expect(sent).toBe(tick + 1);
        now -= 5;
      }
    } finally {
      globalThis.fetch = original;
      Date.now = realNow;
    }
  });

  test('a plain 403 does not open the window', async () => {
    let sent = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { sent += 1; return new Response('{"message":"Forbidden"}', { status: 403 }); }) as typeof fetch;
    try {
      await policedFetch('asp', ASP, `${ASP}/public-key`);
      await policedFetch('asp', ASP, `${ASP}/public-key`);
      expect(sent).toBe(2);
      expect(aspBackoff.blockedForMs()).toBe(0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function fakeClock() {
  let time = 0;
  let id = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => time,
    setTimeout: (fn: () => void, ms: number) => { timers.set(++id, { at: time + ms, fn }); return id; },
    clearTimeout: (handle: unknown) => { timers.delete(handle as number); },
    pending: () => timers.size,
    async advance(ms: number, late = false) {
      const end = time + ms;
      if (late) time = end;
      await settle();
      while (true) {
        const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!first || first[1].at > end) break;
        time = Math.max(time, first[1].at);
        timers.delete(first[0]);
        first[1].fn();
        await settle();
      }
      time = end;
      await settle();
    },
  };
}

describe('production ASP pacing and fixed-grid recovery', () => {
  test('63 concurrent releases are FIFO; late timers cannot create a burst', async () => {
    const clock = fakeClock();
    const pacer = createAspPacer(clock);
    const released: [number, number][] = [];
    const pending = Array.from({ length: 63 }, (_, i) => pacer.wait().then(() => { released.push([i, clock.now()]); }));
    await settle();
    await clock.advance(1_000, true);
    expect(released).toHaveLength(2);
    await clock.advance(63 * ASP_PACE_MS);
    await Promise.all(pending);
    expect(released.map(([i]) => i)).toEqual(Array.from({ length: 63 }, (_, i) => i));
    for (let i = 1; i < released.length; i++) expect(released[i][1] - released[i - 1][1]).toBeGreaterThanOrEqual(ASP_PACE_MS);
    expect(clock.pending()).toBe(0);
  });

  test('aborts remove queued work immediately, reset cancels sleepers, and the queue is bounded', async () => {
    const clock = fakeClock();
    const pacer = createAspPacer(clock);
    await pacer.wait();
    const abort = new AbortController();
    const waiting = pacer.wait(abort.signal).catch(e => e);
    abort.abort();
    expect((await waiting).name).toBe('AbortError');
    expect(clock.pending()).toBe(0);
    const pending = Array.from({ length: ASP_MAX_PENDING }, () => pacer.wait().catch(e => e));
    await expect(pacer.wait()).rejects.toThrow('queue is full');
    pacer.reset();
    expect((await Promise.all(pending)).every(e => e instanceof Error)).toBe(true);
    expect(clock.pending()).toBe(0);
    await pacer.wait();
  });

  test('only one probe is in flight; a slow current probe succeeds and an old-window probe cannot close a new window', async () => {
    const clock = fakeClock();
    const b = createAspBackoff(clock);
    let ended = 0;
    b.onWindowEnd(() => { ended++; });
    b.recordRateLimited(0);
    const first = b.beginProbe()!;
    expect(first).toBeDefined();
    await clock.advance(30_000);
    expect(b.beginProbe()).toBeUndefined();
    b.finishProbe(first, true);
    expect(b.blockedForMs()).toBe(0);
    expect(ended).toBe(1);
    b.recordRateLimited(clock.now());
    const old = b.beginProbe()!;
    await clock.advance(60_000);
    b.recordRateLimited(clock.now());
    b.finishProbe(old, true);
    expect(b.blockedForMs()).toBe(110_000);
    b.reset();
    expect(clock.pending()).toBe(0);
  });

  test('a throttled probe does not add a strike or allow ordinary calls through', async () => {
    const clock = fakeClock();
    const b = createAspBackoff(clock);
    b.recordRateLimited(0);
    const ticket = b.beginProbe()!;
    b.finishProbe(ticket, false);
    expect(b.beginProbe()).toBeUndefined();
    expect(() => b.assertOpen()).toThrow('ASP rate limit exceeded');
    await clock.advance(15_000);
    expect(b.beginProbe()).toBeDefined();
    expect(b.blockedForMs()).toBe(45_000);
    b.reset();
  });

  test('real transport handles 403, flushes a grid burst, refuses user calls, and recovers via its dedicated probe', async () => {
    const clock = fakeClock();
    const b = createAspBackoff(clock);
    const pacer = createAspPacer(clock);
    const transport = createEgressFetch(b, pacer);
    const original = globalThis.fetch;
    let throttle = true;
    const sent: { url: string; at: number }[] = [];
    let ends = 0;
    b.onWindowEnd(() => { ends++; });
    globalThis.fetch = (async (url) => {
      sent.push({ url: String(url), at: clock.now() });
      return throttle ? THROTTLE() : Response.json({ publicKey: 'public' });
    }) as typeof fetch;
    try {
      const pending = Array.from({ length: 63 }, () => transport.policedFetch('asp', ASP, `${ASP}/public-key`).catch(e => e));
      const responses = await Promise.all(pending);
      expect(responses[0].status).toBe(403);
      expect(responses.slice(1).every(e => e instanceof AspBackoffError)).toBe(true);
      expect(sent).toHaveLength(1);
      await clock.advance(15_000);
      // Even at a probe-eligible instant the user's call cannot schedule traffic.
      await expect(transport.policedFetch('asp', ASP, `${ASP}/public-key`)).rejects.toBeInstanceOf(AspBackoffError);
      await transport.probeAsp(ASP);
      expect(b.blockedForMs()).toBe(45_000);
      throttle = false;
      await clock.advance(15_000);
      await transport.probeAsp(ASP);
      expect(ends).toBe(1);
      expect(b.blockedForMs()).toBe(0);
      const next = transport.policedFetch('asp', ASP, `${ASP}/public-key`);
      await clock.advance(ASP_PACE_MS);
      expect((await next).ok).toBe(true);
      expect(sent.map(s => s.at)).toEqual([0, 15_000, 30_000, 30_150]);
    } finally {
      transport.stopAspRequests(); b.reset(); globalThis.fetch = original;
    }
  });

  test('transport stop cancels queued work and timers; restarting preserves the release gap and server backoff', async () => {
    const clock = fakeClock();
    const b = createAspBackoff(clock);
    const pacer = createAspPacer(clock);
    const transport = createEgressFetch(b, pacer);
    const original = globalThis.fetch;
    let sent = 0;
    globalThis.fetch = (async () => { sent++; return Response.json({}); }) as typeof fetch;
    try {
      await transport.policedFetch('asp', ASP, `${ASP}/public-key`);
      const queued = transport.policedFetch('asp', ASP, `${ASP}/public-key`).catch(e => e);
      transport.stopAspRequests();
      expect(await queued).toBeInstanceOf(Error);
      expect(clock.pending()).toBe(0);
      transport.startAspRequests();
      const next = transport.policedFetch('asp', ASP, `${ASP}/public-key`);
      await clock.advance(149);
      expect(sent).toBe(1);
      await clock.advance(1);
      await next;
      b.recordRateLimited(clock.now());
      transport.stopAspRequests();
      expect(clock.pending()).toBe(0);
      transport.startAspRequests();
      await expect(transport.policedFetch('asp', ASP, `${ASP}/public-key`)).rejects.toBeInstanceOf(AspBackoffError);
    } finally {
      transport.stopAspRequests(); b.reset(); globalThis.fetch = original;
    }
  });
});
