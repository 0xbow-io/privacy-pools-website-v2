import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  computePoints,
  epochParamsFromRateLeaves,
  liveEpochParams,
  type Hex,
  type IHashService,
  type PointsEpoch,
  type PointsEpochParams,
  type RateLeavesResponseDto,
} from '@privacy-pools-v2/sdk';

import { aggregatePoints, toPointsNoteInputs } from '@/services/points';
import * as yieldFeeds from '@/services/yield-feeds';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const CHAIN = 11155111;
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const DAY = 86_400n;
const T0 = 1_800_000_000n;

const hex = (v: bigint): Hex => `0x${v.toString(16).padStart(64, '0')}`;

// A deterministic stand-in for Poseidon: the SDK only needs hash(inputs) -> Hex.
const fakeHash: IHashService = {
  hash: (inputs: readonly unknown[]) =>
    hex(inputs.reduce<bigint>((acc, x, i) => (acc * 131n + BigInt(x as string) * BigInt(i + 7) + 1n) % (1n << 250n), 0n)),
} as unknown as IHashService;

// A two-leaf LeanIMT: root = H(H(t0, r0), H(t1, r1)).
function rateRootOf(leaves: [Hex, Hex][]): Hex {
  const [a, b] = leaves.map((leaf) => fakeHash.hash(leaf));
  return fakeHash.hash([a, b]);
}

const EDGES = [0n, 1n, 2n].map((t) => hex((1n << 47n) + t));
const PADDING = hex((1n << 160n) + 1n);

function rateLeaves(epochNumber: bigint, rate: bigint): RateLeavesResponseDto {
  const leaves: [Hex, Hex][] = [[hex(BigInt(USDC)), hex(rate)], [PADDING, hex(0n)]];
  return {
    epochNumber: hex(epochNumber),
    rateRoot: rateRootOf(leaves),
    leaves,
    table: {},
    rateScale: hex(10n ** 18n),
    cliffSeconds: Number(DAY),
    cohortEdges: EDGES,
    cohortWeights: [60_000, 40_000, 20_000, 10_000],
  };
}

function epochRow(epochNumber: bigint, snapshotTime: bigint, rateRoot: Hex | null): PointsEpoch {
  return {
    id: String(epochNumber + 1n),
    epochNumber: hex(epochNumber),
    snapshotBlock: hex(9_000_000n + epochNumber),
    snapshotTime: hex(snapshotTime),
    aspRoot: hex(11n),
    eligibilityRoot: hex(12n),
    eligibilityIpfsCid: 'bafy-eligibility',
    eligibilityLeafCount: 3,
    eligibilityMerkleTreeId: null,
    spentNoteRoot: hex(13n),
    spentNoteIpfsCid: 'bafy-spent',
    spentNoteLeafCount: 2,
    rateRoot,
    rateIpfsCid: rateRoot ? 'bafy-rate' : null,
    rateLeafCount: rateRoot ? 2 : null,
    cliffSeconds: Number(DAY),
    cohortEdges: EDGES,
    cohortWeights: [60_000, 40_000, 20_000, 10_000],
    cohortIpfsCid: null,
    tvlSeriesDigest: null,
    tvlSeriesLastSample: hex(snapshotTime - DAY),
    correctedAt: null,
    correctionTxHash: null,
    publishTxHash: '0xabc',
    createdAt: hex(snapshotTime + 60n),
  };
}

// Run the real points-feed module against a fake api client, without global
// module mocks (they would leak into the rest of the Bun test suite).
function loadFeed(api: {
  getPointsEpochs: (chainId: number, entrypoint?: string, sinceId?: string) => Promise<unknown>;
  getPointsRateLeaves: (chainId: number, epochNumber: bigint, entrypoint?: string) => Promise<unknown>;
}) {
  const exports: Record<string, unknown> = {};
  const source = readFileSync(join(ROOT, 'services/points-feed.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const require = (name: string) => {
    if (name === '@/services/api-client') return { __esModule: true, default: api };
    if (name === '@/services/pool-entrypoint') return { resolveConfiguredEntrypoint: async () => undefined };
    if (name === '@/services/yield-feeds') return yieldFeeds;
    throw new Error(`Unexpected points-feed dependency: ${name}`);
  };
  new Function('require', 'exports', code)(require, exports);
  return exports as typeof import('@/services/points-feed');
}

const E2 = rateLeaves(2n, 10n ** 18n);
const E10 = rateLeaves(10n, 10n ** 18n);

describe('points feed: Hex wire format', () => {
  test('parsePointsHex reads 32-byte hex and refuses the old decimal / ISO values', () => {
    const { parsePointsHex } = loadFeed({ getPointsEpochs: async () => ({}), getPointsRateLeaves: async () => ({}) });
    expect(parsePointsHex(hex(10n), 'x')).toBe(10n);
    expect(parsePointsHex(hex(10n).toUpperCase().replace('0X', '0x'), 'x')).toBe(10n);
    for (const bad of ['10', '0xa', '2026-10-07T00:00:00.000Z', 10, null, `${hex(1n)}0`]) {
      expect(() => parsePointsHex(bad, 'x')).toThrow('not a 32-byte hex value');
    }
  });

  test('orders epochs numerically, skips rate-less ones and asks for rate leaves by decimal number', async () => {
    const asked: bigint[] = [];
    const feed = loadFeed({
      getPointsEpochs: async (_c, _e, sinceId) =>
        sinceId === undefined
          ? { epochs: [epochRow(10n, T0 + 20n * DAY, E10.rateRoot), epochRow(2n, T0 + 10n * DAY, E2.rateRoot), epochRow(1n, T0, null)], lastSyncedId: '11' }
          : { epochs: [], lastSyncedId: '11' },
      getPointsRateLeaves: async (_c, n) => {
        asked.push(n);
        return n === 2n ? E2 : E10;
      },
    });
    const result = await feed.fetchPointsFeed(CHAIN);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.epochs.map((e) => BigInt(e.epoch.epochNumber))).toEqual([2n, 10n]);
    expect(asked).toEqual([2n, 10n]);

    // A rate table is cached per (epoch, rateRoot, correctedAt).
    await feed.fetchPointsFeed(CHAIN);
    expect(asked).toEqual([2n, 10n]);
  });

  test('refuses an epoch row in the old decimal format', async () => {
    const old = { ...epochRow(2n, T0, E2.rateRoot), epochNumber: '2', snapshotTime: '2026-10-07T00:00:00.000Z' };
    const feed = loadFeed({
      getPointsEpochs: async () => ({ epochs: [old], lastSyncedId: '3' }),
      getPointsRateLeaves: async () => E2,
    });
    await expect(feed.fetchPointsFeed(CHAIN)).rejects.toThrow('not a 32-byte hex value');
  });

  test('fails the feed instead of publishing a partial epoch list at the page cap', async () => {
    let pages = 0;
    const feed = loadFeed({
      getPointsEpochs: async () => {
        pages += 1;
        return { epochs: [epochRow(BigInt(pages), T0 + BigInt(pages) * DAY, null)], lastSyncedId: String(pages) };
      },
      getPointsRateLeaves: async () => E2,
    });
    await expect(feed.fetchPointsFeed(CHAIN)).rejects.toThrow('epoch list incomplete');
    expect(pages).toBe(feed.MAX_EPOCH_PAGES);
  });

  test('refuses and does not cache a rate table in the old decimal format', async () => {
    let calls = 0;
    const feed = loadFeed({
      getPointsEpochs: async () => ({ epochs: [epochRow(2n, T0, E2.rateRoot)], lastSyncedId: '3' }),
      getPointsRateLeaves: async () => {
        calls += 1;
        return calls === 1 ? { ...E2, leaves: [[String(BigInt(USDC)), '1000000000000000000']] } : E2;
      },
    });
    await expect(feed.fetchPointsFeed(CHAIN)).rejects.toThrow('not a 32-byte hex value');
    const retry = await feed.fetchPointsFeed(CHAIN);
    expect(retry.status).toBe('ok');
    expect(calls).toBe(2);
  });
});

describe('points: Hex feed through the SDK to the card totals', () => {
  const epochs = [
    { epoch: epochRow(0n, T0 + 10n * DAY, E2.rateRoot), rateLeaves: { ...E2, epochNumber: hex(0n) } },
    { epoch: epochRow(1n, T0 + 20n * DAY, E10.rateRoot), rateLeaves: { ...E10, epochNumber: hex(1n) } },
  ];

  function publishedParams(): PointsEpochParams[] {
    const out: PointsEpochParams[] = [];
    let previous: bigint | null = null;
    for (const { epoch, rateLeaves: leaves } of epochs) {
      const params = epochParamsFromRateLeaves(epoch, leaves, previous, fakeHash);
      out.push(params);
      previous = params.snapshotTime;
    }
    return out;
  }

  test('rate leaves that do not recompute to the epoch rateRoot are refused', () => {
    const forged = { ...epochs[0].rateLeaves, leaves: [[hex(BigInt(USDC)), hex(5n * 10n ** 18n)], [PADDING, hex(0n)]] as [Hex, Hex][] };
    expect(() => epochParamsFromRateLeaves(epochs[0].epoch, forged, null, fakeHash)).toThrow('rate leaves do not recompute to rateRoot');
  });

  test('a pending note\'s published points are pending, never claimable', () => {
    const published = publishedParams();
    const base = { tokenId: USDC, value: '0xde0b6b3a7640000', createdAtBlock: String(T0) };
    const inputs = toPointsNoteInputs(
      [
        { ...base, commitment: `0x${'a'.repeat(64)}`, status: 'ACTIVE' },
        { ...base, commitment: `0x${'b'.repeat(64)}`, status: 'PENDING' },
        { ...base, commitment: `0x${'c'.repeat(64)}`, status: 'SPENT' },
      ],
      () => null,
    );
    const live = liveEpochParams(published[published.length - 1], T0 + 25n * DAY);
    const summary = computePoints(inputs, published, live);
    const [approved, pending, spent] = summary.notes;

    expect(approved.claimable).toBeGreaterThan(0n);
    expect(approved.pending).toBe(0n);
    expect(pending.claimable).toBe(0n);
    expect(pending.pending).toBe(approved.claimable);
    expect(spent.status).toBe('unknown-time');
    expect(summary.total).toBe(summary.claimable + summary.pending + summary.estimated);

    const totals = aggregatePoints([{
      chainId: CHAIN,
      summary,
      symbols: new Map([[USDC, 'USDC']]),
      pendingCommitments: new Set(inputs.filter((n) => n.aspStatus === 'pending').map((n) => n.commitment)),
      latestEpoch: published[published.length - 1].epochNumber,
    }]);
    expect(totals.claimable).toBe(approved.claimable);
    expect(totals.pending).toBe(pending.pending);
    expect(totals.unknownTimeCount).toBe(1);
    expect(totals.latestEpoch).toBe(1n);
    expect(totals.rows).toHaveLength(1);
    expect(totals.rows[0].claimable).toBe(approved.claimable);
    expect(totals.rows[0].pending).toBe(pending.pending);
  });
});
