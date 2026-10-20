import { describe, expect, test } from 'bun:test';
import type { GlobalEvent, GlobalEventsResponse } from '@/services/api-types';
import { activityHeaderCount, readAllGlobalEventPages, totalForChains } from '@/services/global-events-pages';

const ev = (i: number) => ({ eventId: i, txHash: `0x${i}` }) as unknown as GlobalEvent;

/** A fake ASP: `total` rows served `perPageCap` a page, 1-based pages, as prod does. */
function asp(total: number, perPageCap = 100) {
  const calls: number[] = [];
  const fetchPage = async (page: number, perPage: number): Promise<GlobalEventsResponse> => {
    calls.push(page);
    const size = Math.min(perPage, perPageCap);
    const start = (page - 1) * size;
    const events = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, i) => ev(start + i));
    return { page: page - 1, perPage: size, total, events };
  };
  return { fetchPage, calls };
}

describe('readAllGlobalEventPages', () => {
  test('reads every page of a chain, not a first-page window (prod Ethereum: 259)', async () => {
    const { fetchPage, calls } = asp(259);
    const read = await readAllGlobalEventPages(fetchPage);
    expect(read.total).toBe(259);
    expect(read.events).toHaveLength(259);
    expect(new Set(read.events.map((e) => e.eventId)).size).toBe(259);
    expect(calls).toEqual([1, 2, 3]);
  });

  test('stops after one request for an empty chain or a single short page', async () => {
    for (const total of [0, 1, 99]) {
      const { fetchPage, calls } = asp(total);
      const read = await readAllGlobalEventPages(fetchPage);
      expect(read.events).toHaveLength(total);
      expect(calls).toEqual([1]);
    }
  });

  test('an exact multiple of the page size needs no trailing empty request', async () => {
    const { fetchPage, calls } = asp(200);
    await readAllGlobalEventPages(fetchPage);
    expect(calls).toEqual([1, 2]);
  });

  test('the page cap bounds the rows but keeps the ASP total', async () => {
    const { fetchPage, calls } = asp(1000);
    const read = await readAllGlobalEventPages(fetchPage, { maxPages: 2 });
    expect(read.events).toHaveLength(200);
    expect(read.total).toBe(1000);
    expect(calls).toEqual([1, 2]);
  });

  test('a server that clamps perPage below the request still terminates', async () => {
    const { fetchPage } = asp(130, 50);
    const read = await readAllGlobalEventPages(fetchPage, { perPage: 100 });
    // The loop follows the ASP's reported page size, so a clamp reads all rows.
    expect(read.total).toBe(130);
    expect(read.events).toHaveLength(130);
  });
});

/** Newest first, as the feed serves it: ids total-1 .. 0. */
function liveAsp(initial: number) {
  let total = initial;
  const calls: number[] = [];
  let failPage: number | undefined;
  const fetchPage = async (page: number, perPage: number): Promise<GlobalEventsResponse> => {
    calls.push(page);
    if (page === failPage) throw new Error('429');
    const start = (page - 1) * perPage;
    const events = Array.from({ length: Math.max(0, Math.min(perPage, total - start)) }, (_, i) => ev(total - 1 - start - i));
    return { page, perPage, total, events };
  };
  return { fetchPage, calls, add: (n: number) => { total += n; }, failOn: (p?: number) => { failPage = p; } };
}

describe('readAllGlobalEventPages, later ticks', () => {
  test('a tick after the first load is one request and keeps the older rows', async () => {
    const live = liveAsp(259);
    const first = await readAllGlobalEventPages(live.fetchPage);
    live.calls.length = 0;
    live.add(3);
    const next = await readAllGlobalEventPages(live.fetchPage, { previous: first });
    expect(live.calls).toEqual([1]);
    expect(next.total).toBe(262);
    expect(next.events).toHaveLength(262);
    expect(next.events[0].eventId).toBe(261);
  });

  test('a burst larger than page 1 reads deeper again', async () => {
    const live = liveAsp(150);
    const first = await readAllGlobalEventPages(live.fetchPage);
    live.calls.length = 0;
    live.add(120);
    const next = await readAllGlobalEventPages(live.fetchPage, { previous: first });
    expect(live.calls).toEqual([1, 2, 3]);
    expect(next.events).toHaveLength(270);
  });

  test('a deeper page failing keeps the held rows instead of failing the chain', async () => {
    const live = liveAsp(150);
    const first = await readAllGlobalEventPages(live.fetchPage);
    live.add(120);
    live.failOn(2);
    const next = await readAllGlobalEventPages(live.fetchPage, { previous: first });
    expect(next.total).toBe(270);
    expect(new Set(next.events.map((e) => e.eventId)).size).toBe(next.events.length);
    expect(next.events.length).toBe(250);
  });

  test('a first load whose later page fails keeps the pages read, and the next tick reads deeper again', async () => {
    const live = liveAsp(250);
    live.failOn(3);
    const first = await readAllGlobalEventPages(live.fetchPage);
    expect(first.events).toHaveLength(200);
    expect(first.total).toBe(250);
    live.failOn(undefined);
    live.calls.length = 0;
    const next = await readAllGlobalEventPages(live.fetchPage, { previous: first });
    expect(live.calls).toEqual([1, 2, 3]);
    expect(next.events).toHaveLength(250);
  });

  test('a partial read at the row cap is still read again on the next tick', async () => {
    const live = liveAsp(400);
    live.failOn(3);
    const first = await readAllGlobalEventPages(live.fetchPage, { maxPages: 3, previous: { events: Array.from({ length: 300 }, (_, i) => ev(399 - i)), total: 400, complete: false } });
    expect(first.events.length).toBeGreaterThanOrEqual(300);
    expect(first.complete).toBe(false);
    live.failOn(undefined);
    live.calls.length = 0;
    const next = await readAllGlobalEventPages(live.fetchPage, { maxPages: 3, previous: first });
    expect(live.calls).toEqual([1, 2, 3]);
    expect(next.complete).toBe(true);
  });

  test('a row repeated across an offset shift is counted once', async () => {
    let shifted = false;
    const fetchPage = async (page: number): Promise<GlobalEventsResponse> => {
      // Page 2 arrives after one new event, so its first row repeats page 1's last.
      const total = shifted ? 201 : 200;
      const top = total - 1;
      const start = (page - 1) * 100;
      const events = Array.from({ length: Math.max(0, Math.min(100, total - start)) }, (_, i) => ev(top - start - i));
      shifted = true;
      return { page, perPage: 100, total, events };
    };
    const read = await readAllGlobalEventPages(fetchPage);
    expect(new Set(read.events.map((e) => e.eventId)).size).toBe(read.events.length);
    expect(read.events.some((e) => e.eventId === 0)).toBe(true);
  });
});

describe('activityHeaderCount', () => {
  // Prod 2026-10-16: Ethereum 259, BNB Chain 176, Citrea 1.
  const totals = { 1: 259, 56: 176, 4114: 1 };
  const none = new Set<number>();

  test('All tab counts the protocol activity, not the rows held', () => {
    expect(activityHeaderCount({ scopeTab: 'all', scoped: false, rowCount: 77, totals, chainFilter: none })).toBe(436);
  });

  test('the Chain filter narrows the total to its chains', () => {
    expect(activityHeaderCount({ scopeTab: 'all', scoped: false, rowCount: 77, totals, chainFilter: new Set([1]) })).toBe(259);
    expect(totalForChains(totals, [1, 56])).toBe(435);
  });

  test('Mine, a pool-scoped table, or no totals yet keep the row count', () => {
    expect(activityHeaderCount({ scopeTab: 'mine', scoped: false, rowCount: 4, totals, chainFilter: none })).toBe(4);
    expect(activityHeaderCount({ scopeTab: 'all', scoped: true, rowCount: 12, totals, chainFilter: none })).toBe(12);
    expect(activityHeaderCount({ scopeTab: 'all', scoped: false, rowCount: 7, totals: undefined, chainFilter: none })).toBe(7);
    expect(activityHeaderCount({ scopeTab: 'all', scoped: false, rowCount: 7, totals: {}, chainFilter: none })).toBe(7);
  });

  test('a Type, Status, Date or Amount filter shows the filtered rows', () => {
    expect(activityHeaderCount({ scopeTab: 'all', scoped: false, rowCount: 9, totals, chainFilter: new Set([1]), otherFilters: true })).toBe(9);
  });

  test('a chain still loading, or a filtered chain with no total, shows the rows', () => {
    expect(activityHeaderCount({ scopeTab: 'all', scoped: false, rowCount: 60, totals, chainFilter: none, incomplete: true })).toBe(60);
    expect(activityHeaderCount({ scopeTab: 'all', scoped: false, rowCount: 2, totals, chainFilter: new Set([10]) })).toBe(2);
  });
});
