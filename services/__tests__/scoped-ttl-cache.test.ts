import { describe, expect, test } from 'bun:test';

import { ScopedTtlCache } from '@/services/scoped-ttl-cache';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('one slot per scope', () => {
  test('a scoped and an unscoped caller do not evict each other', () => {
    // The whole reason this exists. The single-slot version missed whenever
    // the scope differed, so these two calls thrashed: five screens asking
    // for prices produced five requests, and which ones went out depended on
    // the order the user opened things in.
    const c = new ScopedTtlCache<string>(1000, clock().now);
    c.set('1', 'mainnet');
    c.set(undefined, 'all-chains');
    expect(c.get('1')).toBe('mainnet');
    expect(c.get(undefined)).toBe('all-chains');
    expect(c.size()).toBe(2);
  });

  test('undefined is a real scope, not a miss, and is distinct from a literal', () => {
    const c = new ScopedTtlCache<string>(1000, clock().now);
    c.set(undefined, 'all-chains');
    expect(c.get(undefined)).toBe('all-chains');
    expect(c.get('1')).toBeUndefined();
    // '*' is the internal key for undefined; a caller passing it literally
    // must not collide with the unscoped entry by accident.
    expect(ScopedTtlCache.key(undefined)).toBe('*');
  });

  test('scopes are independent across chains', () => {
    const c = new ScopedTtlCache<number>(1000, clock().now);
    c.set('1', 1);
    c.set('11155111', 2);
    c.set('10', 3);
    expect([c.get('1'), c.get('11155111'), c.get('10')]).toEqual([1, 2, 3]);
  });
});

describe('expiry', () => {
  test('an entry is served until the TTL and refused at it', () => {
    const t = clock();
    const c = new ScopedTtlCache<string>(1000, t.now);
    c.set('1', 'v');
    t.advance(999);
    expect(c.get('1')).toBe('v');
    // At exactly the TTL it is stale: the boundary belongs to the miss, so a
    // caller can never serve a value older than the window it declared.
    t.advance(1);
    expect(c.get('1')).toBeUndefined();
  });

  test('expiry is per scope: one going stale does not take the others', () => {
    const t = clock();
    const c = new ScopedTtlCache<string>(1000, t.now);
    c.set('1', 'early');
    t.advance(600);
    c.set('2', 'late');
    t.advance(500); // '1' is 1100ms old, '2' is 500ms old
    expect(c.get('1')).toBeUndefined();
    expect(c.get('2')).toBe('late');
  });

  test('a stale read drops the entry rather than leaving it to grow', () => {
    const t = clock();
    const c = new ScopedTtlCache<string>(1000, t.now);
    c.set('1', 'v');
    t.advance(2000);
    expect(c.size()).toBe(1);
    c.get('1');
    expect(c.size()).toBe(0);
  });

  test('a backwards clock jump reads as fresh, not as an overflowed miss', () => {
    // NTP can move the clock back. A negative age must not be treated as
    // "older than the TTL", which is what a naive unsigned comparison does.
    const t = clock(10_000);
    const c = new ScopedTtlCache<string>(1000, t.now);
    c.set('1', 'v');
    t.advance(-5000);
    expect(c.get('1')).toBe('v');
  });
});

describe('housekeeping', () => {
  test('clear empties every scope', () => {
    const c = new ScopedTtlCache<string>(1000, clock().now);
    c.set('1', 'a');
    c.set(undefined, 'b');
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.get('1')).toBeUndefined();
    expect(c.get(undefined)).toBeUndefined();
  });

  test('re-setting a scope replaces the value and restarts its window', () => {
    const t = clock();
    const c = new ScopedTtlCache<string>(1000, t.now);
    c.set('1', 'old');
    t.advance(900);
    c.set('1', 'new');
    t.advance(900);
    expect(c.get('1')).toBe('new');
    expect(c.size()).toBe(1);
  });
});
