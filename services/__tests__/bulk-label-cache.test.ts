import { describe, expect, test } from 'bun:test';
import { createBulkLabelCache, createRejectedLabelCache } from '../bulk-label-cache';

const CHAIN = 11155111;
const POOL = '11155111:0xentry';

type FakeStore = {
  read: (poolKey: string, root: string) => readonly string[] | null;
  write: (poolKey: string, root: string, list: readonly string[]) => void;
  remove: (poolKey: string) => void;
  reads: number;
  writes: number;
  data: Map<string, readonly string[]>;
};

function fakeStore(): FakeStore {
  const data = new Map<string, readonly string[]>();
  const st: FakeStore = {
    data,
    remove: poolKey => { for (const key of data.keys()) if (key.startsWith(`${poolKey}:`)) data.delete(key); },
    reads: 0,
    writes: 0,
    read: (poolKey, root) => { st.reads += 1; return data.get(`${poolKey}:${root}`) ?? null; },
    write: (poolKey, root, list) => { st.writes += 1; data.set(`${poolKey}:${root}`, list); },
  };
  return st;
}

function harness(opts: { root?: string | null; ttlMs?: number; now?: () => number; store?: FakeStore } = {}) {
  // NOT `opts.root ?? 'root-a'`: passing null deliberately means "no root
  // probe available", and ?? would turn it back into a root.
  let root: string | null = opts.root === undefined ? 'root-a' : opts.root;
  let rootCalls = 0;
  const cache = createBulkLabelCache({
    fetchRoot: async () => { rootCalls += 1; return root; },
    mapLeaf: (l) => l.toLowerCase(),
    ttlMs: opts.ttlMs ?? 5_000,
    now: opts.now,
    store: opts.store,
  });
  return {
    cache,
    setRoot: (r: string | null) => { root = r; cache.resetRoot(CHAIN); },
    get rootCalls() { return rootCalls; },
  };
}

function source(leaves: string[], failFirst = false) {
  const s = {
    calls: 0,
    getLeaves: async () => {
      s.calls += 1;
      if (failFirst && s.calls === 1) throw new Error('leaf fetch failed');
      // Yield so a burst of callers genuinely overlaps.
      await new Promise((r) => setTimeout(r, 5));
      return leaves;
    },
  };
  return s;
}

describe('createBulkLabelCache', () => {
  test('verification replaces a poisoned durable snapshot and rejects persistent disagreement', async () => {
    const store = fakeStore();
    const h = harness({ store });
    await h.cache.leaves(source(['0xAA']), CHAIN, POOL);
    const current = source(['0xBB']);
    const verify = async () => {
      const leaves = await h.cache.leaves(current, CHAIN, POOL);
      if (leaves[0] !== '0xbb') throw new Error('ASP leaves root mismatch: invalid snapshot');
      return leaves;
    };
    await expect(h.cache.verify(CHAIN, POOL, verify)).rejects.toThrow('invalid snapshot');
    expect(current.calls).toBe(0); // No action-correlated automatic refetch.
    expect(store.data.size).toBe(0);
    expect(await h.cache.verify(CHAIN, POOL, verify)).toEqual(['0xbb']);
    expect(current.calls).toBe(1);
    expect(await harness({ store }).cache.leaves(current, CHAIN, POOL)).toEqual(['0xbb']);
    let attempts = 0;
    await expect(h.cache.verify(CHAIN, POOL, async () => {
      attempts++;
      await h.cache.leaves(current, CHAIN, POOL);
      throw new Error('ASP leaves root mismatch: still invalid');
    })).rejects.toThrow('still invalid');
    expect(attempts).toBe(1);
    expect(store.data.size).toBe(0);
  });

  test('invalidated in-flight leaves cannot republish into memory or durable storage', async () => {
    const store = fakeStore();
    const h = harness({ store });
    let release!: (leaves: string[]) => void;
    const old = h.cache.leaves({ getLeaves: () => new Promise(resolve => { release = resolve; }) }, CHAIN, POOL);
    while (!release) await Promise.resolve();
    h.cache.invalidate(CHAIN, POOL);
    await h.cache.leaves(source(['0xBB']), CHAIN, POOL);
    release(['0xAA']);
    await old;
    expect(await harness({ store }).cache.leaves(source(['0xCC']), CHAIN, POOL)).toEqual(['0xbb']);
  });

  test('a burst of concurrent callers shares ONE leaf fetch', async () => {
    // The regression this pins: awaiting the root probe before the in-flight
    // check made every caller in a ~200-label burst fetch 525KB itself.
    const h = harness();
    const src = source(['0xAA', '0xBB']);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => h.cache.approved(src, CHAIN, POOL)),
    );
    expect(src.calls).toBe(1);
    for (const set of results) expect(set.size).toBe(2);
  });

  test('normalises leaves through mapLeaf', async () => {
    const h = harness();
    const src = source(['0xAA']);
    const set = await h.cache.approved(src, CHAIN, POOL);
    expect(set.has('0xaa')).toBe(true);
    expect(set.has('0xAA')).toBe(false);
  });

  test('an unchanged root serves the cache with no further fetch, regardless of age', async () => {
    let clock = 1_000;
    const h = harness({ now: () => clock });
    const src = source(['0xAA']);
    await h.cache.approved(src, CHAIN, POOL);
    expect(src.calls).toBe(1);

    clock += 10 * 60 * 1000; // far beyond the TTL
    h.cache.resetRoot(CHAIN);  // force a fresh probe; same root comes back
    await h.cache.approved(src, CHAIN, POOL);
    expect(src.calls).toBe(1);
  });

  test('a changed root refetches exactly once, then is stable again', async () => {
    const h = harness();
    const src = source(['0xAA']);
    await h.cache.approved(src, CHAIN, POOL);
    expect(src.calls).toBe(1);

    h.setRoot('root-b');
    await h.cache.approved(src, CHAIN, POOL);
    expect(src.calls).toBe(2);

    await h.cache.approved(src, CHAIN, POOL);
    expect(src.calls).toBe(2);
  });

  test('with no root probe, staleness stays bounded by the TTL', async () => {
    let clock = 1_000;
    const h = harness({ root: null, ttlMs: 5_000, now: () => clock });
    const src = source(['0xAA']);
    await h.cache.approved(src, CHAIN, POOL);
    expect(src.calls).toBe(1);

    clock += 1_000; // inside the TTL: cached
    await h.cache.approved(src, CHAIN, POOL);
    expect(src.calls).toBe(1);

    clock += 10_000; // past the TTL: must refetch rather than serve forever
    await h.cache.approved(src, CHAIN, POOL);
    expect(src.calls).toBe(2);
  });

  test('two POOLS never share a set or await each other', async () => {
    const h = harness();
    const a = source(['0xAA']);
    const b = source(['0xBB', '0xCC']);
    const [setA, setB] = await Promise.all([
      h.cache.approved(a, CHAIN, '11155111:0xpoolA'),
      h.cache.approved(b, CHAIN, '11155111:0xpoolB'),
    ]);
    expect(a.calls).toBe(1);
    expect(b.calls).toBe(1);
    expect(setA.size).toBe(1);
    expect(setB.size).toBe(2);
  });

  test('leaves() preserves served order, which the association-set tree depends on', async () => {
    const h = harness();
    const src = source(['0xCC', '0xAA', '0xBB']);
    const list = await h.cache.leaves(src, CHAIN, POOL);
    expect([...list]).toEqual(['0xcc', '0xaa', '0xbb']);
  });

  test('approved() and leaves() share ONE fetch', async () => {
    const h = harness();
    const src = source(['0xAA']);
    const [list, set] = await Promise.all([
      h.cache.leaves(src, CHAIN, POOL),
      h.cache.approved(src, CHAIN, POOL),
    ]);
    expect(src.calls).toBe(1);
    expect(list.length).toBe(1);
    expect(set.has('0xaa')).toBe(true);
  });

  test('a persisted set for the same root is served without any network fetch', async () => {
    // A cold tab has an empty memory map but can have a valid stored set. This
    // is the whole point of persisting: the leaf set is pool-wide public data.
    const store = fakeStore();
    const first = harness({ store });
    const srcA = source(['0xAA', '0xBB']);
    await first.cache.leaves(srcA, CHAIN, POOL);
    expect(srcA.calls).toBe(1);
    expect(store.writes).toBe(1);

    // Fresh cache instance = a new tab, same store.
    const second = harness({ store });
    const srcB = source(['0xAA', '0xBB']);
    const list = await second.cache.leaves(srcB, CHAIN, POOL);
    expect(srcB.calls).toBe(0);
    expect([...list]).toEqual(['0xaa', '0xbb']);
  });

  test('a changed root misses the store rather than serving a stale set', async () => {
    const store = fakeStore();
    const first = harness({ store });
    await first.cache.leaves(source(['0xAA']), CHAIN, POOL);

    const second = harness({ store });
    second.setRoot('root-b');
    const srcB = source(['0xAA', '0xBB']);
    const list = await second.cache.leaves(srcB, CHAIN, POOL);
    expect(srcB.calls).toBe(1);
    expect(list.length).toBe(2);
  });

  test('with no root probe the store is not consulted, since nothing validates it', async () => {
    const store = fakeStore();
    const h = harness({ root: null, store });
    const src = source(['0xAA']);
    await h.cache.leaves(src, CHAIN, POOL);
    expect(src.calls).toBe(1);
    expect(store.reads).toBe(0);
    expect(store.writes).toBe(0);
  });

  test('a failed fetch clears the in-flight marker so the next call retries', async () => {
    const h = harness();
    const src = source(['0xAA'], true);
    await expect(h.cache.approved(src, CHAIN, POOL)).rejects.toThrow('leaf fetch failed');
    const set = await h.cache.approved(src, CHAIN, POOL);
    expect(src.calls).toBe(2);
    expect(set.size).toBe(1);
  });

  test('the root probe itself is shared across a burst', async () => {
    const h = harness();
    const src = source(['0xAA']);
    await Promise.all(Array.from({ length: 20 }, () => h.cache.approved(src, CHAIN, POOL)));
    expect(h.rootCalls).toBe(1);
  });
});

// A chain the feed grid refreshes (services/public-asp-cache.ts): the SDK reads
// the set while it prepares every spend proof, so a read must never probe or
// fetch. Only the owner's refresh asks the ASP.
describe('createBulkLabelCache, owned by a refresher', () => {
  function owned(opts: { store?: FakeStore } = {}) {
    let root: string | null = 'root-a';
    let rootCalls = 0;
    let rootFails = false;
    const cache = createBulkLabelCache({
      fetchRoot: async () => {
        rootCalls += 1;
        if (rootFails) throw new Error('probe failed');
        return root;
      },
      mapLeaf: (l) => l.toLowerCase(),
      ttlMs: 5_000,
      store: opts.store,
      owns: (chainId) => chainId === CHAIN,
    });
    return {
      cache,
      setRoot: (r: string | null) => { root = r; },
      failProbe: (fail: boolean) => { rootFails = fail; },
      get rootCalls() { return rootCalls; },
    };
  }

  test('a read waits for the owner and never probes or fetches itself', async () => {
    const h = owned();
    const reader = source(['0xREADER']);
    const pending = h.cache.leaves(reader, CHAIN, POOL);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.rootCalls).toBe(0);
    const owner = source(['0xA', '0xB']);
    await h.cache.refresh(owner, CHAIN, POOL);
    expect(await pending).toEqual(['0xa', '0xb']);
    for (let i = 0; i < 5; i += 1) expect(await h.cache.leaves(reader, CHAIN, POOL)).toEqual(['0xa', '0xb']);
    expect(reader.calls).toBe(0);
    expect(h.rootCalls).toBe(1);
  });

  test('the owner refetches the leaves only when the root moved', async () => {
    const h = owned();
    const owner = source(['0xA']);
    await h.cache.refresh(owner, CHAIN, POOL);
    await h.cache.refresh(owner, CHAIN, POOL);
    expect(owner.calls).toBe(1);
    expect(h.rootCalls).toBe(2); // every refresh probes, whatever the TTL
    h.setRoot('root-b');
    await h.cache.refresh(owner, CHAIN, POOL);
    expect(owner.calls).toBe(2);
  });

  test('a read for a pool the owner does not refresh is refused, not fetched', async () => {
    const h = owned();
    await h.cache.refresh(source(['0xA']), CHAIN, POOL);
    const other = source(['0xOTHER']);
    await expect(h.cache.leaves(other, CHAIN, `${CHAIN}:0xelse`)).rejects.toThrow('not the pool the owner refreshes');
    expect(other.calls).toBe(0);
  });

  // e2e run 38292785346: a batch withdrawal right after load failed with
  // "association set not loaded yet". A read now waits for the owner's next
  // refresh instead of failing, and still sends nothing itself.
  test("after an owner's failed first refresh a read waits for the next one", async () => {
    const h = owned();
    const reader = source(['0xREADER']);
    await expect(h.cache.refresh(source(['0xA'], true), CHAIN, POOL)).rejects.toThrow('leaf fetch failed');
    const pending = h.cache.leaves(reader, CHAIN, POOL);
    await h.cache.refresh(source(['0xA']), CHAIN, POOL);
    expect(await pending).toEqual(['0xa']);
    expect(await h.cache.leaves(reader, CHAIN, POOL)).toEqual(['0xa']);
    expect(reader.calls).toBe(0);
  });

  test('root reads use the held set and never probe on behalf of a consumer', async () => {
    const h = owned();
    const reader = source(['0xREADER']);
    await h.cache.refresh(source(['0xA']), CHAIN, POOL);
    expect(await h.cache.root(reader, CHAIN, POOL)).toBe('root-a');
    expect(reader.calls).toBe(0);
    expect(h.rootCalls).toBe(1);
  });

  test('a never-started or hung first refresh cannot strand an owned read', async () => {
    let calls = 0;
    const cache = createBulkLabelCache({
      fetchRoot: () => new Promise(() => {}),
      mapLeaf: l => l,
      ttlMs: 5_000,
      owns: () => true,
      ownedReadWaitMs: 10,
    });
    const reader = { getLeaves: async () => { calls++; return ['1']; } };
    await expect(cache.leaves(reader, CHAIN, POOL)).rejects.toThrow('not loaded yet');
    void cache.refresh(reader, CHAIN, POOL);
    await expect(cache.leaves(reader, CHAIN, POOL)).rejects.toThrow('not loaded yet');
    expect(calls).toBe(0);
  });

  test('a chain nobody owns keeps the reader-driven cache', async () => {
    const h = owned();
    const reader = source(['0xR']);
    expect(await h.cache.leaves(reader, 1, '1:0xentry')).toEqual(['0xr']);
    expect(reader.calls).toBe(1);
  });
});

describe('createRejectedLabelCache', () => {
  test('a proof-boundary lookup bypasses a fresh cached rejection set', async () => {
    let calls = 0;
    let rejected = new Set<string>();
    const cache = createRejectedLabelCache({ ttlMs: 5_000, now: () => 1_000 });
    const fetchSet = async () => {
      calls += 1;
      return rejected;
    };

    expect((await cache.get(POOL, fetchSet))?.has('0xrevoked')).toBe(false);
    rejected = new Set(['0xrevoked']);
    // Ordinary callers share the fresh cache.
    expect((await cache.get(POOL, fetchSet))?.has('0xrevoked')).toBe(false);
    expect(calls).toBe(1);
    // A funds-moving boundary observes the revocation immediately.
    expect((await cache.get(POOL, fetchSet, { forceFresh: true }))?.has('0xrevoked')).toBe(true);
    expect(calls).toBe(2);
  });

  test('concurrent forced lookups still share one in-flight request', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cache = createRejectedLabelCache({ ttlMs: 5_000 });
    const fetchSet = async () => {
      calls += 1;
      await gate;
      return new Set(['0xrevoked']);
    };

    const lookups = Array.from({ length: 20 }, () => (
      cache.get(POOL, fetchSet, { forceFresh: true })
    ));
    release();
    const results = await Promise.all(lookups);
    expect(calls).toBe(1);
    for (const set of results) expect(set?.has('0xrevoked')).toBe(true);
  });
});
