/**
 * The bridge tracker's clock.
 *
 * A cross-chain reshield that HAD delivered was reported as untracked, and the
 * note appeared on a manual page refresh (QA, 2026-09-22). Three things were
 * wrong and each is pinned here:
 *
 *   - the budget was 300 attempts, which is 35 minutes only if the loop is
 *     never rebuilt. It measured the loop's life, not the transaction's.
 *   - one fixed 7s cadence meant "poll longer" and "stop hammering LiFi" were
 *     the same dial.
 *   - nothing re-read the notes while waiting, so the app could not notice a
 *     delivery that had settled ahead of LiFi's index.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BRIDGE_POLL_FAST_WINDOW_MS,
  BRIDGE_POLL_INTERVAL_MS,
  BRIDGE_POLL_MAX_MS,
  BRIDGE_POLL_SLOW_INTERVAL_MS,
  BRIDGE_RESYNC_AFTER_MS,
  BRIDGE_RESYNC_EVERY_MS,
  bridgePollIntervalFor,
  bridgeResyncDue,
} from '@/services/bridge-poll-schedule';

describe('how long it keeps looking', () => {
  test('two hours, and far past the old 35 minutes', () => {
    expect(BRIDGE_POLL_MAX_MS).toBe(7_200_000);
    expect(BRIDGE_POLL_MAX_MS).toBeGreaterThan(300 * BRIDGE_POLL_INTERVAL_MS);
  });
});

describe('how often', () => {
  test('fast while it matters', () => {
    expect(bridgePollIntervalFor(0)).toBe(BRIDGE_POLL_INTERVAL_MS);
    expect(bridgePollIntervalFor(BRIDGE_POLL_FAST_WINDOW_MS - 1)).toBe(BRIDGE_POLL_INTERVAL_MS);
  });

  test('then patient, so a longer window is not a louder one', () => {
    expect(bridgePollIntervalFor(BRIDGE_POLL_FAST_WINDOW_MS)).toBe(BRIDGE_POLL_SLOW_INTERVAL_MS);
    expect(bridgePollIntervalFor(BRIDGE_POLL_MAX_MS)).toBe(BRIDGE_POLL_SLOW_INTERVAL_MS);
    expect(BRIDGE_POLL_SLOW_INTERVAL_MS).toBeGreaterThan(BRIDGE_POLL_INTERVAL_MS);
  });

  test('the whole window costs fewer requests than the old one did', () => {
    const fast = BRIDGE_POLL_FAST_WINDOW_MS / BRIDGE_POLL_INTERVAL_MS;
    const slow = (BRIDGE_POLL_MAX_MS - BRIDGE_POLL_FAST_WINDOW_MS) / BRIDGE_POLL_SLOW_INTERVAL_MS;
    expect(Math.ceil(fast + slow)).toBeLessThan(300);
  });
});

describe('re-reading the notes while waiting', () => {
  test('nothing for the first five minutes: the tracker is the right answer then', () => {
    expect(BRIDGE_RESYNC_AFTER_MS).toBe(300_000);
    expect(bridgeResyncDue(0, null)).toBe(false);
    expect(bridgeResyncDue(BRIDGE_RESYNC_AFTER_MS - 1, null)).toBe(false);
  });

  test('then once, immediately', () => {
    expect(bridgeResyncDue(BRIDGE_RESYNC_AFTER_MS, null)).toBe(true);
  });

  test('and once a minute after that, not every poll', () => {
    const first = BRIDGE_RESYNC_AFTER_MS;
    expect(bridgeResyncDue(first + 1_000, first)).toBe(false);
    expect(bridgeResyncDue(first + BRIDGE_RESYNC_EVERY_MS - 1, first)).toBe(false);
    expect(bridgeResyncDue(first + BRIDGE_RESYNC_EVERY_MS, first)).toBe(true);
  });

  test('a resync is never more frequent than the poll that triggers it', () => {
    expect(BRIDGE_RESYNC_EVERY_MS).toBeGreaterThanOrEqual(BRIDGE_POLL_SLOW_INTERVAL_MS);
  });
});

/**
 * Both trackers use the shared schedule, and neither keeps an attempt counter.
 *
 * They answer the same question about the same LiFi transfer, so a fix to one
 * that is not a fix to the other is how they drift. A source check: both
 * providers need Expo and the pools tree to render.
 */
describe('both bridge trackers', () => {
  const read = (...p: string[]) => readFileSync(join(new URL('.', import.meta.url).pathname, '..', '..', ...p), 'utf8');
  const SOURCES: readonly [string, string][] = [
    ['swap', read('components', 'swap-modal-provider.tsx')],
    ['deposit', read('components', 'deposit-modal-provider.tsx')],
  ];

  for (const [name, source] of SOURCES) {
    test(`${name}: bounded by wall clock, not by attempts`, () => {
      expect(source).toContain('BRIDGE_POLL_MAX_MS');
      expect(source).not.toContain('BRIDGE_POLL_MAX_ATTEMPTS');
      expect(source).not.toMatch(/attempts \+= 1/);
    });

    test(`${name}: backs off through the shared helper`, () => {
      expect(source).toContain('bridgePollIntervalFor(Date.now() - startedAt)');
      // setInterval cannot widen, which is the whole point.
      expect(source).not.toMatch(/setInterval\([^)]*BRIDGE_POLL/);
    });

    test(`${name}: re-reads notes while the delivery is still pending`, () => {
      expect(source).toContain('bridgeResyncDue(elapsed, lastResyncMs)');
    });
  }
});
