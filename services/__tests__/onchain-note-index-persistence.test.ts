import { describe, expect, test } from 'bun:test';

import { eventSnapshotRowsFrom, OnChainNoteIndex } from '@/services/onchain-note-index';
import type { Hex } from '@/services/sdk-types';

/**
 * The block-timestamp map is persisted so a new tab does not re-resolve a few
 * hundred blocks one eth_getBlockByNumber at a time (measured 2026-08-27: ~450
 * calls per cold load, ~72 shed by a rate-limited RPC).
 *
 * These tests pin the parts that could corrupt a commitment leaf if wrong: only
 * well-formed values are ever seeded, and the newest blocks survive eviction
 * because those are the ones a tail scan asks for again.
 */

const KEY = 'ppv2_block_ts_v1:11155111';

// Minimal localStorage stand-in; the module guards on window.localStorage.
function installStore(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  const store = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() { return data.size; },
    clear: () => data.clear(),
  };
  (globalThis as Record<string, unknown>).window = { localStorage: store };
  return { store, data };
}

type Internals = {
  blockTimestamps: Map<string, Hex>;
  persistDirty: boolean;
  loadPersistedBlockTimestamps: () => void;
  flushPersistedBlockTimestamps: () => void;
};

function makeIndex() {
  const index = new OnChainNoteIndex({
    chainId: 11155111,
    poolVaultInteractor: {} as never,
    hashService: {} as never,
  });
  return index as unknown as Internals;
}

/** Each test states its own window/localStorage state, so none inherits another's. */
function clearWindow(): void {
  delete (globalThis as Record<string, unknown>).window;
}

describe('OnChainNoteIndex block-timestamp persistence', () => {

  test('seeds the in-memory map from a previous tab', () => {
    clearWindow();
    installStore({ [KEY]: JSON.stringify({ '0x64': '0x1', '0xc8': '0x2' }) });
    const idx = makeIndex();

    idx.loadPersistedBlockTimestamps();

    expect(idx.blockTimestamps.get('0x64')).toBe('0x1');
    expect(idx.blockTimestamps.get('0xc8')).toBe('0x2');
  });

  test('seeding is idempotent and never overwrites a live entry', () => {
    clearWindow();
    installStore({ [KEY]: JSON.stringify({ '0x64': '0x999' }) });
    const idx = makeIndex();
    idx.blockTimestamps.set('0x64', '0x1' as Hex);

    idx.loadPersistedBlockTimestamps();
    idx.loadPersistedBlockTimestamps();

    // The in-memory value came from a real getBlock this session; a persisted
    // value must not replace it.
    expect(idx.blockTimestamps.get('0x64')).toBe('0x1');
  });

  test('rejects malformed persisted values rather than trusting them', () => {
    clearWindow();
    // A corrupted entry that became a timestamp would produce a commitment leaf
    // that does not exist on-chain, failing only inside the circuit.
    installStore({
      [KEY]: JSON.stringify({
        '0x64': 'not-hex',
        '0xc8': 123,
        '0xfa': null,
        '0x12c': '0x2a',
      }),
    });
    const idx = makeIndex();

    idx.loadPersistedBlockTimestamps();

    expect(idx.blockTimestamps.has('0x64')).toBe(false);
    expect(idx.blockTimestamps.has('0xc8')).toBe(false);
    expect(idx.blockTimestamps.has('0xfa')).toBe(false);
    expect(idx.blockTimestamps.get('0x12c')).toBe('0x2a');
  });

  test('survives a corrupt store without throwing', () => {
    clearWindow();
    installStore({ [KEY]: '{not json' });
    const idx = makeIndex();

    expect(() => idx.loadPersistedBlockTimestamps()).not.toThrow();
    expect(idx.blockTimestamps.size).toBe(0);
  });

  test('is a no-op with no window (native / SSR)', () => {
    clearWindow();
    const idx = makeIndex();
    expect(() => idx.loadPersistedBlockTimestamps()).not.toThrow();
    expect(() => idx.flushPersistedBlockTimestamps()).not.toThrow();
  });

  test('flush writes what was resolved, and only when dirty', () => {
    clearWindow();
    const { data } = installStore();
    const idx = makeIndex();
    idx.blockTimestamps.set('0x64', '0x1' as Hex);

    // Not dirty: nothing written, so an untouched map never rewrites the store.
    idx.flushPersistedBlockTimestamps();
    expect(data.has(KEY)).toBe(false);

    idx.persistDirty = true;
    idx.flushPersistedBlockTimestamps();
    expect(JSON.parse(data.get(KEY)!)).toEqual({ '0x64': '0x1' });
  });

  test('eviction keeps the NEWEST blocks, which the tail scan needs again', () => {
    clearWindow();
    const { data } = installStore();
    const idx = makeIndex();
    // 20_001 entries: one over the cap.
    for (let i = 0; i <= 20_000; i += 1) {
      idx.blockTimestamps.set(`0x${i.toString(16)}`, '0x1' as Hex);
    }
    idx.persistDirty = true;

    idx.flushPersistedBlockTimestamps();

    const persisted = JSON.parse(data.get(KEY)!) as Record<string, string>;
    expect(Object.keys(persisted)).toHaveLength(20_000);
    // Newest survived, oldest (block 0) was dropped.
    expect(persisted[`0x${(20_000).toString(16)}`]).toBe('0x1');
    expect(persisted['0x0']).toBeUndefined();
  });
});

/**
 * An ASP-supplied block timestamp must never buy the chain-verified exemption.
 *
 * chainVerified means "we read this block ourselves", which is the provenance
 * that lets a commitment skip the on-chain leaf proof. A timestamp the ASP
 * volunteered is a claim, so a commitment dated from one has to keep proving
 * itself; otherwise a wrong or malicious value is trusted and fails only inside
 * a zk circuit, long after the fact.
 */
describe('OnChainNoteIndex ASP-hint provenance', () => {
  test('markChainVerified skips blocks dated from an ASP hint', () => {
    clearWindow();
    const index = new OnChainNoteIndex({
      chainId: 11155111,
      poolVaultInteractor: {} as never,
      hashService: {} as never,
    });
    const internals = index as unknown as {
      aspSourcedBlocks: Set<string>;
      markChainVerified: (t: { chainVerified: Set<string> }, c: string, b: unknown) => void;
    };
    const target = { chainVerified: new Set<string>() };

    // Block 100 came from the chain, block 200 from an ASP hint.
    internals.aspSourcedBlocks.add('200');

    internals.markChainVerified(target, 'commitment-from-chain', 100n);
    internals.markChainVerified(target, 'commitment-from-asp', 200n);

    expect(target.chainVerified.has('commitment-from-chain')).toBe(true);
    expect(target.chainVerified.has('commitment-from-asp')).toBe(false);
  });

  test('accepts hex or decimal block notation for the same block', () => {
    clearWindow();
    const index = new OnChainNoteIndex({
      chainId: 11155111,
      poolVaultInteractor: {} as never,
      hashService: {} as never,
    });
    const internals = index as unknown as {
      aspSourcedBlocks: Set<string>;
      markChainVerified: (t: { chainVerified: Set<string> }, c: string, b: unknown) => void;
    };
    const target = { chainVerified: new Set<string>() };

    // The tail records String(blockNumber); a caller passing a bigint of the
    // same block must still be recognised as ASP-sourced.
    internals.aspSourcedBlocks.add(String(200n));
    internals.markChainVerified(target, 'c', 200n);

    expect(target.chainVerified.size).toBe(0);
  });
});

/**
 * The tail-timestamp hint loader must be INJECTED, never imported.
 *
 * Wiring api-client directly into the index made the whole test suite perform
 * real HTTP against the live ASP: 2.5s to 6.0s, and a golden accounting test
 * started depending on live data. loadEventSnapshot already existed for exactly
 * this reason; the delta loader follows it.
 */
describe('OnChainNoteIndex tail-timestamp hints', () => {
  const internalsOf = (index: OnChainNoteIndex) =>
    index as unknown as { recordTailTimestampHints: (from: bigint) => Promise<void> };

  test('does nothing at all when no loader is injected', async () => {
    clearWindow();
    const index = new OnChainNoteIndex({
      chainId: 11155111,
      poolVaultInteractor: {} as never,
      hashService: {} as never,
    });

    // No loader, no network, no throw.
    expect(await internalsOf(index).recordTailTimestampHints(100n)).toBeUndefined();
  });

  test('records hints from every event section the delta returns', async () => {
    clearWindow();
    const { getAspBlockTimestamp, __resetAspBlockTimestamps } = await import('@/services/asp-block-timestamps');
    __resetAspBlockTimestamps();
    let askedFrom: bigint | null = null;
    const index = new OnChainNoteIndex({
      chainId: 11155111,
      poolVaultInteractor: {} as never,
      hashService: {} as never,
      loadEventSnapshotDelta: async (since: bigint) => {
        askedFrom = since;
        return {
          deposits: [{ blockNumber: '100', blockTimestamp: '2026-08-27T14:08:12.000Z' }],
          transacts: [{ blockNumber: '101', blockTimestamp: '2026-08-27T14:08:24.000Z' }],
          ragequits: [{ blockNumber: '102', blockTimestamp: '2026-08-27T14:08:36.000Z' }],
        };
      },
    });

    await internalsOf(index).recordTailTimestampHints(100n);

    expect(askedFrom).toBe(100n);
    expect(getAspBlockTimestamp(11155111, 100n)).toBe('0x6a9044cc');
    expect(getAspBlockTimestamp(11155111, 101n)).toBe('0x6a9044d8');
    expect(getAspBlockTimestamp(11155111, 102n)).toBe('0x6a9044e4');
  });

  test('never asks for a negative block', async () => {
    clearWindow();
    let askedFrom: bigint | null = null;
    const index = new OnChainNoteIndex({
      chainId: 11155111,
      poolVaultInteractor: {} as never,
      hashService: {} as never,
      loadEventSnapshotDelta: async (since: bigint) => {
        askedFrom = since;
        return { deposits: [] };
      },
    });

    await internalsOf(index).recordTailTimestampHints(-500n);

    expect(askedFrom).toBe(0n);
  });

  test("the app's loader takes the tail's rows from the held snapshot, with no request of its own", async () => {
    clearWindow();
    const { getAspBlockTimestamp, __resetAspBlockTimestamps } = await import('@/services/asp-block-timestamps');
    __resetAspBlockTimestamps();
    const held = {
      snapshotBlockNumber: '102',
      deposits: [
        { blockNumber: '40', blockTimestamp: '2026-08-27T13:00:00.000Z' },
        { blockNumber: '100', blockTimestamp: '2026-08-27T14:08:12.000Z' },
      ],
      transacts: [{ blockNumber: '101', blockTimestamp: '2026-08-27T14:08:24.000Z' }, { blockNumber: 'bad' }],
      ragequits: [{ blockNumber: '102', blockTimestamp: '2026-08-27T14:08:36.000Z' }],
      notes: [{ blockNumber: '101' }],
    };
    expect(eventSnapshotRowsFrom(held, 100n)).toEqual({
      deposits: [held.deposits[1]],
      transacts: [held.transacts[0]],
      ragequits: [held.ragequits[0]],
    });
    expect(eventSnapshotRowsFrom(null, 0n)).toEqual({ deposits: [], transacts: [], ragequits: [] });

    // The tail-hint memory is app-wide per chain, so this test has its own.
    const index = new OnChainNoteIndex({
      chainId: 900_004,
      poolVaultInteractor: {} as never,
      hashService: {} as never,
      loadEventSnapshotDelta: async (since: bigint) => eventSnapshotRowsFrom(held, since),
    });
    await internalsOf(index).recordTailTimestampHints(100n);
    expect(getAspBlockTimestamp(900_004, 40n)).toBeNull();
    expect(getAspBlockTimestamp(900_004, 100n)).toBe('0x6a9044cc');
    expect(getAspBlockTimestamp(900_004, 102n)).toBe('0x6a9044e4');
  });

  test('a failing loader is swallowed, leaving the chain as the source', async () => {
    clearWindow();
    const index = new OnChainNoteIndex({
      chainId: 11155111,
      poolVaultInteractor: {} as never,
      hashService: {} as never,
      loadEventSnapshotDelta: async () => {
        throw new Error('ASP down');
      },
    });

    expect(await internalsOf(index).recordTailTimestampHints(100n)).toBeUndefined();
  });
});

describe('OnChainNoteIndex tail-hint repeat suppression', () => {
  const internalsOf = (index: OnChainNoteIndex) =>
    index as unknown as { recordTailTimestampHints: (from: bigint) => Promise<void> };

  test('the same window is not refetched within the TTL', async () => {
    // A real load ran this four times and the later calls reported
    // "rows=234 recorded=0" - the same rows, none new, ~260KB each.
    clearWindow();
    let calls = 0;
    // The memory is app-wide per chain, so each test uses its own chain id.
    const index = new OnChainNoteIndex({
      chainId: 900_001,
      poolVaultInteractor: {} as never,
      hashService: {} as never,
      loadEventSnapshotDelta: async () => {
        calls += 1;
        return { deposits: [{ blockNumber: '100', blockTimestamp: '2026-08-27T14:08:12.000Z' }] };
      },
    });

    await internalsOf(index).recordTailTimestampHints(100n);
    await internalsOf(index).recordTailTimestampHints(100n);
    await internalsOf(index).recordTailTimestampHints(100n);

    expect(calls).toBe(1);
  });

  test('a NEW index on the same chain does not refetch the same window (2026-10-01)', async () => {
    // Every withdraw, transfer and spendability check builds its own index;
    // a per-instance memory re-sent the same sinceBlock on every press.
    clearWindow();
    let calls = 0;
    const build = () => new OnChainNoteIndex({
      chainId: 900_003,
      poolVaultInteractor: {} as never,
      hashService: {} as never,
      loadEventSnapshotDelta: async () => {
        calls += 1;
        return { deposits: [] };
      },
    });
    await internalsOf(build()).recordTailTimestampHints(100n);
    await internalsOf(build()).recordTailTimestampHints(100n);
    await internalsOf(build()).recordTailTimestampHints(100n);
    expect(calls).toBe(1);
  });

  test('a different window still fetches', async () => {
    clearWindow();
    let calls = 0;
    const index = new OnChainNoteIndex({
      chainId: 900_002,
      poolVaultInteractor: {} as never,
      hashService: {} as never,
      loadEventSnapshotDelta: async () => {
        calls += 1;
        return { deposits: [] };
      },
    });

    await internalsOf(index).recordTailTimestampHints(100n);
    await internalsOf(index).recordTailTimestampHints(200n);

    expect(calls).toBe(2);
  });
});
