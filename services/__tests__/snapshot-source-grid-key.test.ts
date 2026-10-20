import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import * as snapshotCache from '@/services/snapshot-cache';
import * as noteCiphertexts from '@/services/note-ciphertexts';
import * as aspEventSnapshot from '@/services/asp-event-snapshot';
import * as snapshotDelta from '@/services/snapshot-delta';

// The grid pins the pool it refreshes on each chain. A failed entrypoint
// lookup names no pool, so it must not be pinned: the chain-only request it
// would stand for is the wrong pool's on a multi-pool chain, and the SDK's own
// pool would be refused until reload.

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const STORE_FLAG = '__ppv2SnapshotStore';
const LEAVES_STORE_FLAG = '__ppv2PoolLeavesStore';
const CHAIN = 11155111;
const POOL = '0xCA1E072236D231130059eeA6Bfceb7F4e9a1F0C3';

// The real module against a fake API client and entrypoint lookup, without
// global module mocks (they would leak into the rest of the Bun test suite).
function loadSource(deps: {
  getEventSnapshotPayload: (chainId: number, include: unknown, since?: bigint, entrypoint?: string) => Promise<unknown>;
  resolveConfiguredEntrypoint: (chainId: number) => Promise<string | undefined>;
}) {
  delete (globalThis as Record<string, unknown>)[STORE_FLAG];
  delete (globalThis as Record<string, unknown>)[LEAVES_STORE_FLAG];
  const exports: Record<string, unknown> = {};
  const source = readFileSync(join(ROOT, 'services/snapshot-source.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const require = (name: string) => {
    if (name === '@/services/api-client') return { __esModule: true, default: { getEventSnapshotPayload: deps.getEventSnapshotPayload } };
    if (name === '@/services/pool-entrypoint') return { resolveConfiguredEntrypoint: deps.resolveConfiguredEntrypoint };
    if (name === '@/services/snapshot-cache') return snapshotCache;
    if (name === '@/services/note-ciphertexts') return noteCiphertexts;
    if (name === '@/services/asp-event-snapshot') return aspEventSnapshot;
    if (name === '@/services/snapshot-delta') return snapshotDelta;
    if (name === '@/services/chain-block-time') return { blockTimeMs: () => 12_000 };
    if (name === '@/config/chains') return { getChainConfig: () => undefined };
    if (name === '@/services/public-feed-scheduler') return { publicFeeds: { isRunning: () => false, registered: () => [] } };
    throw new Error(`Unexpected snapshot-source dependency: ${name}`);
  };
  new Function('require', 'exports', code)(require, exports);
  return exports as typeof import('@/services/snapshot-source');
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[STORE_FLAG];
  delete (globalThis as Record<string, unknown>)[LEAVES_STORE_FLAG];
});

test('a failed entrypoint lookup fails that refresh, and the next one looks the pool up again', async () => {
  const requested: Array<string | undefined> = [];
  let lookups = 0;
  let lookupFails = true;
  const source = loadSource({
    getEventSnapshotPayload: async (chainId, _include, _since, entrypoint) => {
      requested.push(entrypoint);
      return { chainId: String(chainId), snapshotBlockNumber: '100', generatedAt: '', deposits: [], transacts: [], ragequits: [], notes: [] };
    },
    resolveConfiguredEntrypoint: async () => {
      lookups += 1;
      if (lookupFails) throw new Error('entrypoints throttled');
      return POOL;
    },
  });

  await expect(source.refreshPoolEventSnapshot(CHAIN)).rejects.toThrow('entrypoints throttled');
  // No chain-only request stood in for the pool, and readers get the failure.
  expect(requested).toEqual([]);
  expect(await source.poolEventSnapshotHeldAt(CHAIN)).toBeUndefined();

  lookupFails = false;
  await source.refreshPoolEventSnapshot(CHAIN);
  expect(requested).toEqual([POOL.toLowerCase()]);
  expect(typeof await source.poolEventSnapshotHeldAt(CHAIN)).toBe('number');

  // An answered lookup is kept for the rest of the page.
  await source.refreshPoolEventSnapshot(CHAIN);
  expect(lookups).toBe(2);
  expect(requested).toEqual([POOL.toLowerCase(), POOL.toLowerCase()]);
});

test('a pool the feed does not list is an answer, and stays the chain-only key', async () => {
  const requested: Array<string | undefined> = [];
  let lookups = 0;
  const source = loadSource({
    getEventSnapshotPayload: async (chainId, _include, _since, entrypoint) => {
      requested.push(entrypoint);
      return { chainId: String(chainId), snapshotBlockNumber: '100', generatedAt: '', deposits: [], transacts: [], ragequits: [], notes: [] };
    },
    resolveConfiguredEntrypoint: async () => {
      lookups += 1;
      return undefined;
    },
  });

  await source.refreshPoolEventSnapshot(CHAIN);
  await source.refreshPoolEventSnapshot(CHAIN);
  expect(lookups).toBe(1);
  expect(requested).toEqual([undefined, undefined]);
});

test('the leaves feed pins its pool the same way', async () => {
  const requested: Array<string | undefined> = [];
  let lookupFails = true;
  const source = loadSource({
    getEventSnapshotPayload: async (chainId, _include, _since, entrypoint) => {
      requested.push(entrypoint);
      return { chainId: String(chainId), snapshotBlockNumber: '100', generatedAt: '', leaves: [], keystoreLeaves: [] };
    },
    resolveConfiguredEntrypoint: async () => {
      if (lookupFails) throw new Error('entrypoints throttled');
      return POOL;
    },
  });

  await expect(source.refreshPoolLeaves(CHAIN)).rejects.toThrow('entrypoints throttled');
  expect(requested).toEqual([]);
  lookupFails = false;
  await source.refreshPoolLeaves(CHAIN);
  expect(requested).toEqual([POOL.toLowerCase()]);
  // The SDK's own pool is served, and nothing is fetched to serve it.
  await source.loadPoolLeaves(CHAIN, { entrypoint: POOL });
  expect(requested).toEqual([POOL.toLowerCase()]);
});
