import { describe, expect, test } from 'bun:test';
import { createSnapshotStore } from '@/services/snapshot-cache';

const POOL = '1:0xca1e';

function harness(opts: { failFull?: boolean; failUpdate?: boolean } = {}) {
  const calls: string[] = [];
  let t = 1_000;
  const store = createSnapshotStore<{ rows: number[] }>({
    fetchFull: async () => {
      calls.push('full');
      await new Promise((r) => setTimeout(r, 5));
      if (opts.failFull) throw new Error('throttled');
      return { rows: [1, 2] };
    },
    fetchUpdate: async (_pool: string, held: { rows: number[] }) => {
      calls.push(`update(${held.rows.join(',')})`);
      if (opts.failUpdate) throw new Error('throttled');
      return { rows: [...held.rows, held.rows.length + 1] };
    },
    now: () => t,
  });
  return { store, calls, advance: (ms: number) => { t += ms; } };
}

describe('createSnapshotStore: only the owner fetches', () => {
  test('a read of an owned pool never fetches: it waits for the owner, then shares its copy', async () => {
    const h = harness();
    const early = h.store.read(POOL, { mayBootstrap: false });
    expect(h.calls).toEqual([]);
    await h.store.refresh(POOL);
    expect((await early).rows).toEqual([1, 2]);
    for (let i = 0; i < 5; i += 1) await h.store.read(POOL, { mayBootstrap: false });
    expect(h.calls).toEqual(['full']);
  });

  test('a burst of readers during the first refresh shares that one request', async () => {
    const h = harness();
    const first = h.store.refresh(POOL);
    const reads = await Promise.all(Array.from({ length: 20 }, () => h.store.read(POOL, { mayBootstrap: false })));
    await first;
    expect(h.calls).toEqual(['full']);
    for (const r of reads) expect(r.rows).toEqual([1, 2]);
  });

  test("the owner's later refreshes top the held copy up, and readers see the newest", async () => {
    const h = harness();
    await h.store.refresh(POOL);
    await h.store.refresh(POOL);
    await h.store.refresh(POOL);
    expect((await h.store.read(POOL, { mayBootstrap: false })).rows).toEqual([1, 2, 3, 4]);
    expect(h.calls).toEqual(['full', 'update(1,2)', 'update(1,2,3)']);
  });

  test('a failed first refresh is not retried by readers: they get the failure until the owner tries again', async () => {
    const h = harness({ failFull: true });
    const waiting = h.store.read(POOL, { mayBootstrap: false }).then(() => 'resolved', (error: Error) => error.message);
    await expect(h.store.refresh(POOL)).rejects.toThrow('throttled');
    expect(await waiting).toBe('throttled');
    await expect(h.store.read(POOL, { mayBootstrap: false })).rejects.toThrow('throttled');
    expect(h.calls).toEqual(['full']);
  });

  test('a failed top-up keeps serving the held copy', async () => {
    const h = harness({ failUpdate: true });
    await h.store.refresh(POOL);
    await expect(h.store.refresh(POOL)).rejects.toThrow('throttled');
    expect((await h.store.read(POOL, { mayBootstrap: false })).rows).toEqual([1, 2]);
  });

  test('with no owner, the first read is the one download and later reads reuse it', async () => {
    const h = harness();
    await h.store.read(POOL, { mayBootstrap: true });
    await h.store.read(POOL, { mayBootstrap: true });
    expect(h.calls).toEqual(['full']);
  });

  test('heldAt moves only when a refresh lands', async () => {
    const h = harness();
    expect(h.store.heldAt(POOL)).toBeUndefined();
    await h.store.refresh(POOL);
    expect(h.store.heldAt(POOL)).toBe(1_000);
    h.advance(120_000);
    await h.store.read(POOL, { mayBootstrap: false });
    expect(h.store.heldAt(POOL)).toBe(1_000);
    await h.store.refresh(POOL);
    expect(h.store.heldAt(POOL)).toBe(121_000);
  });

  test('heldAt is when the refresh was asked for, not when it landed', async () => {
    // A payment that lands while the request is in flight may be missing from
    // the copy, so nothing reasoning from absence may date the copy later.
    const h = harness();
    const landing = h.store.refresh(POOL);
    h.advance(30_000);
    await landing;
    expect(h.store.heldAt(POOL)).toBe(1_000);
  });

  test('a reset forgets the copy, so the next page-load download is whole again', async () => {
    const h = harness();
    await h.store.refresh(POOL);
    h.store.reset();
    await h.store.refresh(POOL);
    expect(h.calls).toEqual(['full', 'full']);
  });

  test('pools are independent', async () => {
    const h = harness();
    await h.store.refresh(POOL);
    const other = h.store.read('56:0xca1e', { mayBootstrap: false });
    await h.store.refresh('56:0xca1e');
    await other;
    expect(h.calls).toEqual(['full', 'full']);
  });
});
