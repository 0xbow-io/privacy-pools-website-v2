import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { OnChainNoteIndex } from '@/services/onchain-note-index';
import {
  parseSnapshotPoolState,
  resetSnapshotPoolStateMemo,
  verifySnapshotPoolState,
} from '@/services/snapshot-pool-state';
import type { Hex } from '@/services/sdk-types';

/**
 * Fixtures follow the producer shape of asp-v2#150's poolState: every number a
 * decimal string, roots and lastLeafIndex null on an empty pool.
 */
const POOL = '0xabcdef0123456789abcdef0123456789abcdef01';
const CHAIN = 4114;
const SNAPSHOT_BLOCK = 2_000_000n;
// Newest row is far below the advertised block: the quiet-pool case.
const ROW_BLOCK = 830_000n;
const ROOT = 12345678901234567890123456789n;

const pad = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const hashService = { hash: (inputs: Hex[]): Hex => pad(BigInt(inputs.length)) };

function producerPoolState(overrides: Record<string, unknown> = {}) {
  return {
    blockNumber: String(SNAPSHOT_BLOCK),
    stateRoot: String(ROOT),
    stateLeafCount: '3',
    lastLeafIndex: '2',
    keystoreRoot: '987654321',
    keystoreLeafCount: '1',
    ragequitCount: '0',
    ...overrides,
  };
}

function snapshot(poolState?: unknown, rows = true) {
  return {
    chainId: String(CHAIN),
    snapshotBlockNumber: String(SNAPSHOT_BLOCK),
    generatedAt: '2026-10-19T00:00:00.000Z',
    deposits: rows
      ? [{ outputCommitment: pad(0xaaan), blockTimestamp: '2026-09-22T00:00:00.000Z', blockNumber: String(ROW_BLOCK) }]
      : [],
    transacts: [],
    ragequits: [],
    ...(poolState === undefined ? {} : { poolState }),
  };
}

function makeIndex(opts: {
  snap: unknown;
  stateRootAt?: (b: bigint) => Promise<bigint>;
  poolStateCheck?: boolean;
  transacts?: Array<{ blockNumber: Hex; outputCommitments: Hex[]; nullifierHashes: Hex[] }>;
}) {
  const vault = {
    getStateLeaves: mock(async () => []),
    getDepositedEvents: mock(async (_from?: Hex, _to?: Hex) => []),
    getTransactedEvents: mock(async (from?: Hex, to?: Hex) =>
      (opts.transacts ?? []).filter((t) => (from === undefined || BigInt(t.blockNumber) >= BigInt(from)) && to === undefined)),
    getRagequitEvents: mock(async (_from?: Hex, _to?: Hex) => []),
  };
  const stateRootAt = mock(opts.stateRootAt ?? (async () => ROOT));
  const index = new OnChainNoteIndex({
    chainId: CHAIN,
    poolVaultInteractor: vault as never,
    hashService: hashService as never,
    loadEventSnapshot: async () => opts.snap,
    ...(opts.poolStateCheck === false ? {} : { poolStateCheck: { poolAddress: POOL, reader: { stateRootAt } } }),
  });
  (index as unknown as { fetchBlockTimestamps: () => Promise<Map<string, Hex>> }).fetchBlockTimestamps =
    async () => new Map();
  // The open-ended tail scans only; a (b, b) call is a heal proof fetch.
  const tailFrom = () => vault.getDepositedEvents.mock.calls.filter((c) => c[1] === undefined).map((c) => c[0]);
  return { index, vault, stateRootAt, tailFrom };
}

const hex = (n: bigint) => `0x${n.toString(16)}`;
const TRUSTED_START = hex(SNAPSHOT_BLOCK - 300n);
const PROVEN_START = hex(ROW_BLOCK - 300n);

beforeEach(() => resetSnapshotPoolStateMemo());

describe('snapshot poolState trust', () => {
  test('matching root: the tail starts at the advertised cursor', async () => {
    const { index, stateRootAt, tailFrom } = makeIndex({ snap: snapshot(producerPoolState()) });
    await index.refresh();
    expect(tailFrom()).toEqual([TRUSTED_START]);
    expect(stateRootAt.mock.calls).toEqual([[SNAPSHOT_BLOCK]]);
  });

  test('root mismatch: falls back to the proven bound', async () => {
    const { index, tailFrom } = makeIndex({ snap: snapshot(producerPoolState()), stateRootAt: async () => ROOT + 1n });
    await index.refresh();
    expect(tailFrom()).toEqual([PROVEN_START]);
  });

  test('missing poolState: unchanged proven-bound behaviour', async () => {
    const { index, stateRootAt, tailFrom } = makeIndex({ snap: snapshot() });
    await index.refresh();
    expect(tailFrom()).toEqual([PROVEN_START]);
    expect(stateRootAt.mock.calls.length).toBe(0);
  });

  test('no poolStateCheck wired: unchanged even with a valid poolState', async () => {
    const { index, tailFrom } = makeIndex({ snap: snapshot(producerPoolState()), poolStateCheck: false });
    await index.refresh();
    expect(tailFrom()).toEqual([PROVEN_START]);
  });

  test('poolState block != snapshot block: falls back without reading', async () => {
    const { index, stateRootAt, tailFrom } = makeIndex({
      snap: snapshot(producerPoolState({ blockNumber: String(SNAPSHOT_BLOCK - 1n) })),
    });
    await index.refresh();
    expect(tailFrom()).toEqual([PROVEN_START]);
    expect(stateRootAt.mock.calls.length).toBe(0);
  });

  test('stateLeafCount != lastLeafIndex + 1: falls back', async () => {
    const { index, tailFrom } = makeIndex({ snap: snapshot(producerPoolState({ stateLeafCount: '4' })) });
    await index.refresh();
    expect(tailFrom()).toEqual([PROVEN_START]);
  });

  test('read failure: falls back to the proven bound', async () => {
    const { index, tailFrom } = makeIndex({
      snap: snapshot(producerPoolState()),
      stateRootAt: async () => { throw new Error('header not found'); },
    });
    await index.refresh();
    expect(tailFrom()).toEqual([PROVEN_START]);
  });

  test('malformed poolState field: falls back', async () => {
    const { index, tailFrom } = makeIndex({ snap: snapshot(producerPoolState({ stateRoot: '0xabc' })) });
    await index.refresh();
    expect(tailFrom()).toEqual([PROVEN_START]);
  });

  test('empty pool, null roots: trusted only when the chain root is 0', async () => {
    const empty = producerPoolState({
      stateRoot: null, stateLeafCount: '0', lastLeafIndex: null, keystoreRoot: null, keystoreLeafCount: '0',
    });
    const ok = makeIndex({ snap: snapshot(empty, false), stateRootAt: async () => 0n });
    await ok.index.refresh();
    // No rows prove anything, so without poolState this would be a full scan.
    expect(ok.tailFrom()).toEqual([TRUSTED_START]);

    resetSnapshotPoolStateMemo();
    const bad = makeIndex({ snap: snapshot(empty, false), stateRootAt: async () => ROOT });
    await bad.index.refresh();
    expect(bad.tailFrom()).toEqual([undefined]);
  });

  test('a claimed root of 0 never matches', async () => {
    const verdict = await verifySnapshotPoolState({
      chainId: CHAIN, poolAddress: POOL, raw: snapshot(producerPoolState({ stateRoot: '0' })),
      snapshotBlock: SNAPSHOT_BLOCK, reader: { stateRootAt: async () => 0n },
    });
    expect(verdict.trusted).toBe(false);
  });
});

describe('parseSnapshotPoolState', () => {
  test('parses the producer shape and rejects partial ones', () => {
    expect(parseSnapshotPoolState(snapshot(producerPoolState()))?.stateRoot).toBe(ROOT);
    expect(parseSnapshotPoolState(snapshot())).toBeNull();
    const { ragequitCount: _drop, ...partial } = producerPoolState();
    expect(parseSnapshotPoolState(snapshot(partial))).toBeNull();
    expect(parseSnapshotPoolState(snapshot(producerPoolState({ blockNumber: 2000000 })))).toBeNull();
  });
});

describe('builds do not inherit coverage from each other', () => {
  test('a spend an earlier build read from the chain tail is still seen by the next build', async () => {
    // Regression for the review P1: a shared "scanned through H" cursor made
    // build 2 start above a spend only build 1 had loaded, and build() starts
    // from an empty index, so the spend vanished.
    const spend = { blockNumber: hex(SNAPSHOT_BLOCK + 20n) as Hex, outputCommitments: [], nullifierHashes: [pad(0x777n)] };
    const snap = snapshot(producerPoolState());
    const first = makeIndex({ snap, transacts: [spend] });
    await first.index.refresh();
    expect(first.index.isNullifierSpent(pad(0x777n))).toBe(true);
    const second = makeIndex({ snap, transacts: [spend] });
    await second.index.refresh();
    expect(second.index.isNullifierSpent(pad(0x777n))).toBe(true);
    // The verified block is not read again, and the tail still starts at the snapshot cursor.
    expect(second.stateRootAt.mock.calls.length).toBe(0);
    expect(second.tailFrom()).toEqual([TRUSTED_START]);
    // Same index rebuilt: still seen.
    await second.index.refresh({ force: true });
    expect(second.index.isNullifierSpent(pad(0x777n))).toBe(true);
  });
});

describe('pool address case', () => {
  test('a verified block is remembered regardless of address case', async () => {
    const raw = snapshot(producerPoolState());
    const first = mock(async () => ROOT);
    expect((await verifySnapshotPoolState({ chainId: CHAIN, poolAddress: POOL, raw, snapshotBlock: SNAPSHOT_BLOCK, reader: { stateRootAt: first } })).trusted).toBe(true);
    const upper = `0x${POOL.slice(2).toUpperCase()}`;
    expect(upper).not.toBe(POOL);
    const second = mock(async () => ROOT);
    expect((await verifySnapshotPoolState({ chainId: CHAIN, poolAddress: upper, raw, snapshotBlock: SNAPSHOT_BLOCK, reader: { stateRootAt: second } })).trusted).toBe(true);
    expect(second.mock.calls.length).toBe(0);
  });
});
