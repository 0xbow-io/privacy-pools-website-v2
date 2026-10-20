import { describe, expect, test } from 'bun:test';

import { createBlockNumberMemo } from '@/services/block-number-memo';
import { DEFAULT_BLOCK_TIME_MS, blockTimeByChain, blockTimeMs } from '@/services/chain-block-time';

function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function counter(values: bigint[]) {
  let i = 0;
  const fetch = async () => {
    const v = values[Math.min(i, values.length - 1)];
    i += 1;
    return v;
  };
  return { fetch, calls: () => i };
}

describe('chain block time', () => {
  test('known chains', () => {
    expect(blockTimeMs(1)).toBe(12_000);
    expect(blockTimeMs(11155111)).toBe(12_000);
    expect(blockTimeMs(10)).toBe(2_000);
    expect(blockTimeMs(8453)).toBe(2_000);
    expect(blockTimeMs(56)).toBe(750);
    expect(blockTimeMs(4114)).toBe(2_000);
  });

  test('unknown chain gets the default', () => {
    expect(blockTimeMs(999_999)).toBe(DEFAULT_BLOCK_TIME_MS);
  });

  test('per-chain map for wagmi', () => {
    expect(blockTimeByChain([1, 56])).toEqual({ 1: 12_000, 56: 750 });
  });
});

describe('block number memo', () => {
  test('one request per block time per chain', async () => {
    const clock = fakeClock();
    const memo = createBlockNumberMemo({ ttlMs: blockTimeMs, now: clock.now });
    const src = counter([100n, 101n]);
    expect(await memo.get(1, src.fetch)).toBe(100n);
    clock.advance(11_999);
    expect(await memo.get(1, src.fetch)).toBe(100n);
    expect(src.calls()).toBe(1);
    clock.advance(1);
    expect(await memo.get(1, src.fetch)).toBe(101n);
    expect(src.calls()).toBe(2);
  });

  test('chains do not share a head', async () => {
    const clock = fakeClock();
    const memo = createBlockNumberMemo({ ttlMs: blockTimeMs, now: clock.now });
    expect(await memo.get(1, async () => 5n)).toBe(5n);
    expect(await memo.get(10, async () => 9n)).toBe(9n);
  });

  test('concurrent callers share one in-flight request', async () => {
    const clock = fakeClock();
    const memo = createBlockNumberMemo({ ttlMs: blockTimeMs, now: clock.now });
    const src = counter([7n]);
    const all = await Promise.all([memo.get(1, src.fetch), memo.get(1, src.fetch), memo.get(1, src.fetch)]);
    expect(all).toEqual([7n, 7n, 7n]);
    expect(src.calls()).toBe(1);
  });

  test('a failure propagates and is not remembered', async () => {
    const clock = fakeClock();
    const memo = createBlockNumberMemo({ ttlMs: blockTimeMs, now: clock.now });
    await expect(memo.get(1, async () => { throw new Error('down'); })).rejects.toThrow('down');
    expect(await memo.get(1, async () => 3n)).toBe(3n);
  });

  test('a receipt raises a fresh head, never lowers it, never creates one', async () => {
    const clock = fakeClock();
    const memo = createBlockNumberMemo({ ttlMs: blockTimeMs, now: clock.now });
    memo.observe(1, 50n);
    const src = counter([40n, 60n]);
    expect(await memo.get(1, src.fetch)).toBe(40n);
    memo.observe(1, 45n);
    expect(await memo.get(1, src.fetch)).toBe(45n);
    memo.observe(1, 44n);
    expect(await memo.get(1, src.fetch)).toBe(45n);
    expect(src.calls()).toBe(1);
  });

  test('a lagging node does not walk back a head raised while the request was in flight', async () => {
    const clock = fakeClock();
    const memo = createBlockNumberMemo({ ttlMs: blockTimeMs, now: clock.now });
    await memo.get(1, async () => 40n);
    clock.advance(12_000);
    let release!: (v: bigint) => void;
    const pending = memo.get(1, () => new Promise<bigint>((r) => { release = r; }));
    // Stale entry, refresh in flight: the receipt's block still wins.
    memo.observe(1, 99n);
    release(41n);
    expect(await pending).toBe(99n);
    expect(await memo.get(1, async () => 0n)).toBe(99n);
  });

  test('a floor seen during a failed refresh is dropped with it', async () => {
    const clock = fakeClock();
    const memo = createBlockNumberMemo({ ttlMs: blockTimeMs, now: clock.now });
    let fail!: (e: Error) => void;
    const pending = memo.get(1, () => new Promise<bigint>((_, rej) => { fail = rej; }));
    memo.observe(1, 99n);
    fail(new Error('rpc down'));
    await expect(pending).rejects.toThrow('rpc down');
    expect(await memo.get(1, async () => 50n)).toBe(50n);
  });
});
