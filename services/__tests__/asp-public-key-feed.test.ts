import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ASP_BACKOFF_BASE_MS, ASP_BACKOFF_MAX_MS, createAspBackoff } from '@/services/asp-backoff';
import { feedData, PublicFeedScheduler } from '@/services/public-feed-scheduler';

// A deposit cannot be sealed without the ASP's key, and the grid re-reads it
// only every 30 minutes. A first fetch that fails must not leave deposits
// refused for that long: a server error is retried within seconds, and a
// throttle is waited out, with nothing sent until the ASP's window ends.

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const KEY = `0x${'ab'.repeat(32)}`;

// The module's real values. Importing it would load the app config, which
// needs react-native.
const cacheSource = readFileSync(join(ROOT, 'services/public-asp-cache.ts'), 'utf8');
function constant(name: string): number {
  const declared = new RegExp(`export const ${name} = ([\\d_ *]+);`).exec(cacheSource);
  if (!declared) throw new Error(`${name} is not declared in services/public-asp-cache.ts`);
  return Number(new Function(`return (${declared[1]});`)());
}
const ASP_PUBLIC_KEY_INTERVAL_MS = constant('ASP_PUBLIC_KEY_INTERVAL_MS');
const ASP_PUBLIC_KEY_RETRY_MS = constant('ASP_PUBLIC_KEY_RETRY_MS');

type Answer = 'ok' | 'throttled' | 'server-error';

function harness(answers: Answer[]) {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock = {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (handle: unknown) => { timers.delete(handle as number); },
  };
  const backoff = createAspBackoff(clock);
  const sent: number[] = [];
  const scheduler = new PublicFeedScheduler(clock);
  scheduler.register({
    key: 'asp-public-key',
    intervalMs: ASP_PUBLIC_KEY_INTERVAL_MS,
    retryMs: ASP_PUBLIC_KEY_RETRY_MS,
    // What services/egress-fetch.ts does around every ASP request.
    fetch: async () => {
      backoff.assertOpen();
      const sentAt = backoff.now();
      sent.push(sentAt);
      const answer = answers.shift() ?? 'ok';
      if (answer === 'throttled') {
        backoff.recordRateLimited(sentAt);
        throw new Error('API request failed: 403 Forbidden: Rate limit exceeded');
      }
      if (answer === 'server-error') throw new Error('API request failed: 502 Bad Gateway');
      backoff.recordSuccess(sentAt);
      return KEY;
    },
  });
  return {
    scheduler,
    sent,
    async advanceTo(target: number) {
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        for (let i = 0; i < 12; i += 1) await Promise.resolve();
      }
      now = target;
    },
    held: () => feedData(scheduler.read<string>('asp-public-key')),
  };
}

describe('the ASP public key recovers from a failed first fetch', () => {
  test('a server error is retried well inside the throttle window', async () => {
    expect(ASP_PUBLIC_KEY_RETRY_MS).toBeLessThan(ASP_BACKOFF_BASE_MS);
    const h = harness(['server-error', 'ok']);
    h.scheduler.start();
    await h.advanceTo(ASP_PUBLIC_KEY_RETRY_MS);
    expect(h.sent).toEqual([0, ASP_PUBLIC_KEY_RETRY_MS]);
    expect(h.held()).toBe(KEY);
    // Then back to the slow cadence.
    await h.advanceTo(ASP_PUBLIC_KEY_INTERVAL_MS);
    expect(h.sent).toEqual([0, ASP_PUBLIC_KEY_RETRY_MS, ASP_PUBLIC_KEY_INTERVAL_MS]);
    h.scheduler.stop();
  });

  test('a throttle is waited out: nothing is sent until the window ends', async () => {
    const h = harness(['throttled', 'ok']);
    h.scheduler.start();
    await h.advanceTo(ASP_BACKOFF_BASE_MS - 1);
    // The retries inside the window were refused before reaching the network.
    expect(h.sent).toEqual([0]);
    expect(h.held()).toBeUndefined();
    await h.advanceTo(ASP_BACKOFF_BASE_MS);
    expect(h.sent).toEqual([0, ASP_BACKOFF_BASE_MS]);
    expect(h.held()).toBe(KEY);
    h.scheduler.stop();
  });

  test('a second throttle waits out the longer window, then the next retry instant goes', async () => {
    const h = harness(['throttled', 'throttled', 'ok']);
    h.scheduler.start();
    const secondWindowEnds = ASP_BACKOFF_BASE_MS + ASP_BACKOFF_MAX_MS;
    const firstRetryAfter = Math.ceil(secondWindowEnds / ASP_PUBLIC_KEY_RETRY_MS) * ASP_PUBLIC_KEY_RETRY_MS;
    await h.advanceTo(firstRetryAfter);
    expect(h.sent).toEqual([0, ASP_BACKOFF_BASE_MS, firstRetryAfter]);
    expect(h.held()).toBe(KEY);
    h.scheduler.stop();
  });

  test('the app registers the key feed with its retry grid', () => {
    const feeds = readFileSync(join(ROOT, 'services/public-feeds.ts'), 'utf8');
    expect(feeds).toMatch(/key: FEED_ASP_PUBLIC_KEY,\s*intervalMs: ASP_PUBLIC_KEY_INTERVAL_MS,\s*retryMs: ASP_PUBLIC_KEY_RETRY_MS,/);
  });
});
