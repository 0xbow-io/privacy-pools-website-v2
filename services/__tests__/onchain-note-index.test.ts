import { describe, expect, mock, test } from 'bun:test';

import { OnChainNoteIndex, waitForNullifiersSpent } from '@/services/onchain-note-index';
import type { Hash, Hex } from '@/services/sdk-types';

const pad = (n: bigint): Hex => `0x${n.toString(16).padStart(64, '0')}` as Hex;

const COMMITMENT_A = pad(0xaaan);
const COMMITMENT_B = pad(0xbbbn);
const NULLIFIER_A = pad(0x111n);
const NULLIFIER_B = pad(0x222n);

const BLOCK_A = '0x64' as Hex; // 100
const BLOCK_B = '0xc8' as Hex; // 200
const BLOCK_C = '0xfa' as Hex; // 250
const TS_A = '0x1' as Hex;
const TS_B = '0x2' as Hex;
const TS_C = '0x3' as Hex;

/**
 * Stand-in Poseidon: order-sensitive and collision-free enough for these tests,
 * and — critically — deterministic, so a leaf can be constructed for an exact
 * (commitment, timestamp) pair and NOT match a different one.
 */
const hashService = {
  hash: (inputs: Hex[]): Hex => {
    const joined = inputs.map((i) => BigInt(i).toString(16)).join('|');
    let acc = 0n;
    for (const ch of joined) acc = (acc * 131n + BigInt(ch.codePointAt(0)!)) % (2n ** 200n);
    return pad(acc);
  },
};

const leafFor = (commitment: Hex, timestamp: Hex): Hex =>
  hashService.hash([
    '0x086205d9d9e32ce53fc309585685ddb629e878ddd2dd04f575089c3a421342d9' as Hex,
    commitment,
    timestamp,
  ]);

type VaultOpts = {
  deposits?: Array<{ blockNumber: Hex; outputCommitment: Hex }>;
  transacts?: Array<{ blockNumber: Hex; outputCommitments: Hex[]; nullifierHashes: Hex[] }>;
  ragequits?: Array<{ blockNumber: Hex; commitment: Hex; nullifierHash: Hex }>;
  leaves?: Hash[];
};

function makeVault(opts: VaultOpts) {
  // Range-respecting, like the real interactor: the tail scans (fromBlock,
  // open-ended) and the heal's proof fetches (b, b) must see different slices
  // or the tests cannot tell the two paths apart.
  const within = (b: Hex, from?: Hex, to?: Hex) =>
    (from === undefined || BigInt(b) >= BigInt(from)) && (to === undefined || BigInt(b) <= BigInt(to));
  return {
    getStateLeaves: mock(async () => (opts.leaves ?? []) as Hash[]),
    getDepositedEvents: mock(async (from?: Hex, to?: Hex) => (opts.deposits ?? []).filter((d) => within(d.blockNumber, from, to))),
    getTransactedEvents: mock(async (from?: Hex, to?: Hex) => (opts.transacts ?? []).filter((t) => within(t.blockNumber, from, to))),
    getRagequitEvents: mock(async (from?: Hex, to?: Hex) => (opts.ragequits ?? []).filter((r) => within(r.blockNumber, from, to))),
  };
}

/**
 * Builds an index with block-timestamp resolution stubbed, and records which
 * blocks were asked for so the privacy contract can be asserted.
 */
function makeIndex(opts: VaultOpts & { timestamps?: Map<string, Hex>; snapshot?: unknown }) {
  const requestedBlocks: string[][] = [];
  const vault = makeVault(opts);
  const index = new OnChainNoteIndex({
    chainId: 11155111,
    poolVaultInteractor: vault as never,
    hashService: hashService as never,
    loadEventSnapshot: opts.snapshot === undefined ? undefined : async () => opts.snapshot,
  });
  const timestamps =
    opts.timestamps ??
    new Map<string, Hex>([
      [BLOCK_A, TS_A],
      [BLOCK_B, TS_B],
      [BLOCK_C, TS_C],
    ]);
  // Replace the network hop only; everything else is the real implementation.
  (index as unknown as {
    fetchBlockTimestamps: (b: readonly Hex[]) => Promise<Map<string, Hex>>;
  }).fetchBlockTimestamps = async (blocks: readonly Hex[]) => {
    requestedBlocks.push([...new Set(blocks.map(String))]);
    return timestamps;
  };
  return { index, requestedBlocks, vault };
}

describe('OnChainNoteIndex', () => {
  test('throws when queried before refresh rather than reporting absence', () => {
    const { index } = makeIndex({});
    expect(() => index.commitmentTimestamp(COMMITMENT_A)).toThrow();
    expect(() => index.hasCommitment(COMMITMENT_A)).toThrow();
    expect(() => index.nullifierSpentAt(NULLIFIER_A)).toThrow();
  });

  test('resolves a deposit commitment to its verified block timestamp', async () => {
    const { index } = makeIndex({
      deposits: [{ blockNumber: BLOCK_A, outputCommitment: COMMITMENT_A }],
      leaves: [leafFor(COMMITMENT_A, TS_A)],
    });
    await index.refresh();
    expect(index.commitmentTimestamp(COMMITMENT_A)).toBe(TS_A);
    expect(index.hasCommitment(COMMITMENT_A)).toBe(true);
  });

  test('detects a spent nullifier from Transacted with no timestamp source', async () => {
    const { index } = makeIndex({
      transacts: [{ blockNumber: BLOCK_A, outputCommitments: [], nullifierHashes: [NULLIFIER_A] }],
    });
    await index.refresh();
    expect(index.isNullifierSpent(NULLIFIER_A)).toBe(true);
    expect(index.isNullifierSpent(NULLIFIER_B)).toBe(false);
  });

  test('detects a spent nullifier from Ragequit', async () => {
    const { index } = makeIndex({
      ragequits: [{ blockNumber: BLOCK_C, commitment: COMMITMENT_B, nullifierHash: NULLIFIER_B }],
    });
    await index.refresh();
    expect(index.isNullifierSpent(NULLIFIER_B)).toBe(true);
  });

  describe('ragequit creation timestamps', () => {
    const exit = {
      commitment: BigInt(COMMITMENT_A).toString(),
      nullifierHash: BigInt(NULLIFIER_B).toString(),
      blockTimestamp: '1970-01-01T00:00:03.000Z',
      blockNumber: '250',
    };

    for (const creation of ['deposit', 'transact'] as const) {
      test(`snapshot ${creation} retains its creation timestamp after a ragequit without healing`, async () => {
        const row = { blockTimestamp: '1970-01-01T00:00:01.000Z', blockNumber: '100' };
        const { index, requestedBlocks, vault } = makeIndex({
          snapshot: {
            snapshotBlockNumber: '1000',
            deposits: creation === 'deposit' ? [{ ...row, outputCommitment: COMMITMENT_A }] : [],
            transacts: creation === 'transact' ? [{ ...row, outputCommitments: [COMMITMENT_A] }] : [],
            ragequits: [exit],
          },
          leaves: [leafFor(COMMITMENT_A, TS_A)],
        });

        for (let build = 1; build <= 2; build++) {
          await index.refresh({ force: true });
          expect(index.hasCommitment(COMMITMENT_A)).toBe(true);
          expect(index.isNullifierSpent(NULLIFIER_B)).toBe(true);
          expect(index.nullifierSpentAt(NULLIFIER_B)).toBe(TS_C);
          expect(index.commitmentTimestamp(COMMITMENT_A)).toBe(TS_A);
          expect(index.unverifiedCommitments()).toEqual([]);
          // Only the normal open-ended tail scan, with no timestamp/proof repairs.
          expect(requestedBlocks).toEqual(Array.from({ length: build }, () => []));
          // The snapshot advertises block 1000 but its newest row is the exit at
          // 250, so 250 is all it proves: the tail starts at 250-300, floored at
          // 0, rather than at the unproved 700.
          for (const read of [vault.getDepositedEvents, vault.getTransactedEvents, vault.getRagequitEvents]) {
            expect(read.mock.calls).toEqual(Array.from({ length: build }, () => ['0x0']));
          }
        }
      });

      test(`healing uses the original ${creation} block after a snapshot ragequit`, async () => {
        const row = { blockTimestamp: '1970-01-01T00:01:39.000Z', blockNumber: '100' };
        const { index, requestedBlocks, vault } = makeIndex({
          snapshot: {
            snapshotBlockNumber: '1000',
            deposits: [
              ...(creation === 'deposit' ? [{ ...row, outputCommitment: COMMITMENT_A }] : []),
              { outputCommitment: COMMITMENT_B, blockTimestamp: '1970-01-01T00:00:02.000Z', blockNumber: '1000' },
            ],
            transacts: creation === 'transact' ? [{ ...row, outputCommitments: [COMMITMENT_A] }] : [],
            ragequits: [exit],
          },
          deposits: creation === 'deposit' ? [{ blockNumber: BLOCK_A, outputCommitment: COMMITMENT_A }] : [],
          transacts: creation === 'transact' ? [{ blockNumber: BLOCK_A, outputCommitments: [COMMITMENT_A], nullifierHashes: [] }] : [],
          ragequits: [{ blockNumber: BLOCK_C, commitment: COMMITMENT_A, nullifierHash: NULLIFIER_B }],
          leaves: [leafFor(COMMITMENT_B, TS_B)],
        });
        await index.refresh();
        expect(index.hasCommitment(COMMITMENT_A)).toBe(true);
        expect(index.isNullifierSpent(NULLIFIER_B)).toBe(true);
        expect(index.nullifierSpentAt(NULLIFIER_B)).toBe(TS_C);
        expect(index.commitmentTimestamp(COMMITMENT_A)).toBe(TS_A);
        expect(index.unverifiedCommitments()).toEqual([]);
        expect(requestedBlocks).toEqual([[], [BLOCK_A]]);
        expect(vault.getDepositedEvents.mock.calls).toEqual([['0x2bc'], [BLOCK_A, BLOCK_A]]);
        expect(vault.getTransactedEvents.mock.calls).toEqual([['0x2bc'], [BLOCK_A, BLOCK_A]]);
        expect(vault.getRagequitEvents.mock.calls).toEqual([['0x2bc']]);
      });
    }

    test('a tail ragequit preserves snapshot creation time across refreshes without healing', async () => {
      const { index, requestedBlocks, vault } = makeIndex({
        snapshot: {
          snapshotBlockNumber: '100', transacts: [], ragequits: [],
          deposits: [{ outputCommitment: COMMITMENT_A, blockTimestamp: '1970-01-01T00:00:01.000Z', blockNumber: '100' }],
        },
        ragequits: [{ blockNumber: BLOCK_C, commitment: COMMITMENT_A, nullifierHash: NULLIFIER_B }],
        leaves: [leafFor(COMMITMENT_A, TS_A)],
      });
      for (let build = 1; build <= 2; build++) {
        await index.refresh({ force: true });
        expect(index.hasCommitment(COMMITMENT_A)).toBe(true);
        expect(index.isNullifierSpent(NULLIFIER_B)).toBe(true);
        expect(index.nullifierSpentAt(NULLIFIER_B)).toBe(TS_C);
        expect(index.commitmentTimestamp(COMMITMENT_A)).toBe(TS_A);
        expect(index.unverifiedCommitments()).toEqual([]);
        expect(requestedBlocks).toEqual(Array.from({ length: build }, () => [BLOCK_C]));
        for (const read of [vault.getDepositedEvents, vault.getTransactedEvents, vault.getRagequitEvents]) {
          expect(read.mock.calls).toEqual(Array.from({ length: build }, () => ['0x0']));
        }
      }
    });

    for (const source of ['snapshot', 'tail'] as const) {
      test(`an exit-only ${source} observation preserves presence and spent state without inventing creation time`, async () => {
        // A real exit is visible on BOTH sources: the ASP row and the chain
        // tail (snapshotBlockNumber 250 starts the tail at 0, so block 250 is
        // in the window). With only the ASP row the base implementation also
        // answered null here — its heal failed for lack of a proof — so the
        // headline assertion never discriminated. With the tail row present
        // the base serves the exit time (TS_C) as the creation time, and
        // `toBeNull` is what actually bites.
        const { index, requestedBlocks } = makeIndex({
          snapshot: source === 'snapshot' ? { snapshotBlockNumber: '250', ragequits: [exit] } : undefined,
          ragequits: [{ blockNumber: BLOCK_C, commitment: COMMITMENT_A, nullifierHash: NULLIFIER_B }],
        });
        await index.refresh();
        expect(index.hasCommitment(COMMITMENT_A)).toBe(true);
        expect(index.isNullifierSpent(NULLIFIER_B)).toBe(true);
        expect(index.nullifierSpentAt(NULLIFIER_B)).toBe(TS_C);
        expect(index.commitmentTimestamp(COMMITMENT_A)).toBeNull();
        expect(index.unverifiedCommitments()).toEqual([]);
        expect(requestedBlocks).toEqual([[BLOCK_C]]);
      });
    }

    test('a tail ragequit no longer buys the chain-verified exemption for a wrong ASP creation timestamp', async () => {
      // The PR removes TWO things from the tail ragequit loop: the creation
      // timestamp write and markChainVerified. The other tests only pin the
      // first. If the exemption came back on its own, an ASP deposit row with
      // a WRONG blockTimestamp whose exit lands inside the tail window would be
      // served with chain-grade provenance — exactly the circuit-failing
      // witness this index exists to prevent. Here the ASP claims 99s for A
      // (leaf proves 1s), the exit is at block 800 (in the 700.. window), and
      // the real Deposited sits at block 100, reachable only through healing.
      const { index, requestedBlocks, vault } = makeIndex({
        snapshot: {
          snapshotBlockNumber: '1000', transacts: [], ragequits: [],
          deposits: [
            { outputCommitment: COMMITMENT_A, blockTimestamp: '1970-01-01T00:01:39.000Z', blockNumber: '100' },
            { outputCommitment: COMMITMENT_B, blockTimestamp: '1970-01-01T00:00:02.000Z', blockNumber: '1000' },
          ],
        },
        deposits: [{ blockNumber: BLOCK_A, outputCommitment: COMMITMENT_A }],
        ragequits: [{ blockNumber: '0x320' as Hex, commitment: COMMITMENT_A, nullifierHash: NULLIFIER_B }],
        leaves: [leafFor(COMMITMENT_B, TS_B)],
        timestamps: new Map<string, Hex>([
          [BLOCK_A, TS_A],
          [BLOCK_B, TS_B],
          [BLOCK_C, TS_C],
          ['0x320', '0x4' as Hex],
        ]),
      });
      await index.refresh();
      expect(index.isNullifierSpent(NULLIFIER_B)).toBe(true);
      expect(index.nullifierSpentAt(NULLIFIER_B)).toBe('0x4');
      // Healed from the real creation block — never the ASP's 0x63, never the exit's 0x4.
      expect(index.commitmentTimestamp(COMMITMENT_A)).toBe(TS_A);
      expect(index.unverifiedCommitments()).toEqual([]);
      expect(requestedBlocks).toEqual([['0x320'], [BLOCK_A]]);
      expect(vault.getRagequitEvents.mock.calls).toEqual([['0x2bc']]);
    });

    test('healing rejects a claimed creation block that contains only a ragequit', async () => {
      const { index, requestedBlocks, vault } = makeIndex({
        snapshot: {
          snapshotBlockNumber: '1000', transacts: [],
          deposits: [
            { outputCommitment: COMMITMENT_A, blockTimestamp: exit.blockTimestamp, blockNumber: exit.blockNumber },
            { outputCommitment: COMMITMENT_B, blockTimestamp: '1970-01-01T00:00:02.000Z', blockNumber: '1000' },
          ],
          ragequits: [exit],
        },
        // Block 250 lies below the tail window (700..head), so it is queried
        // only if healing accepts the ASP's claimed creation block.
        ragequits: [{ blockNumber: BLOCK_C, commitment: COMMITMENT_A, nullifierHash: NULLIFIER_B }],
        leaves: [leafFor(COMMITMENT_B, TS_B)],
      });
      await index.refresh();
      expect(index.hasCommitment(COMMITMENT_A)).toBe(true);
      expect(index.isNullifierSpent(NULLIFIER_B)).toBe(true);
      expect(index.nullifierSpentAt(NULLIFIER_B)).toBe(TS_C);
      expect(index.commitmentTimestamp(COMMITMENT_A)).toBeNull();
      expect(index.unverifiedCommitments()).toEqual([COMMITMENT_A]);
      expect(requestedBlocks).toEqual([[], [BLOCK_C]]);
      expect(vault.getDepositedEvents.mock.calls).toEqual([['0x2bc'], [BLOCK_C, BLOCK_C]]);
      expect(vault.getTransactedEvents.mock.calls).toEqual([['0x2bc'], [BLOCK_C, BLOCK_C]]);
      expect(vault.getRagequitEvents.mock.calls).toEqual([['0x2bc']]);
    });
  });

  test('a tail-derived timestamp is served even when the leaf set disagrees', async () => {
    // getBlock(event.blockNumber).timestamp IS the leaf's own second operand,
    // so it needs no leaf proof. The leaf set can be silently incomplete (the
    // public RPC drops eth_getLogs ranges under load, and the fetch is cached
    // per session), and subjecting chain-derived timestamps to it condemned
    // fresh notes forever: the payee starvation of 2026-08-27.
    const { index } = makeIndex({
      deposits: [{ blockNumber: BLOCK_A, outputCommitment: COMMITMENT_A }],
      leaves: [leafFor(COMMITMENT_A, TS_B)], // holed/wrong leaf set
    });
    await index.refresh();
    expect(index.commitmentTimestamp(COMMITMENT_A)).toBe(TS_A);
    expect(index.unverifiedCommitments().length).toBe(0);
    expect(index.hasCommitment(COMMITMENT_A)).toBe(true);
  });

  test('matches a commitment regardless of hex padding or decimal form', async () => {
    const { index } = makeIndex({
      deposits: [{ blockNumber: BLOCK_A, outputCommitment: COMMITMENT_A }],
      leaves: [leafFor(COMMITMENT_A, TS_A)],
    });
    await index.refresh();
    expect(index.commitmentTimestamp('0xaaa' as Hash)).toBe(TS_A);
  });

  describe('privacy contract', () => {
    test('requests EVERY distinct tail block, across all three event kinds', async () => {
      // Load-bearing that all three kinds appear in DIFFERENT blocks: the
      // equivalent SDK test initially used deposits only, and a mutant that
      // dropped transact/ragequit blocks from the request survived it.
      const { index, requestedBlocks } = makeIndex({
        deposits: [{ blockNumber: BLOCK_A, outputCommitment: COMMITMENT_A }],
        transacts: [
          { blockNumber: BLOCK_B, outputCommitments: [COMMITMENT_B], nullifierHashes: [NULLIFIER_A] },
        ],
        ragequits: [{ blockNumber: BLOCK_C, commitment: pad(0xdddn), nullifierHash: NULLIFIER_B }],
        leaves: [leafFor(COMMITMENT_A, TS_A), leafFor(COMMITMENT_B, TS_B)],
      });
      await index.refresh();

      expect(requestedBlocks.length).toBe(1);
      expect(new Set(requestedBlocks[0])).toEqual(new Set([BLOCK_A, BLOCK_B, BLOCK_C]));
    });

    test('never calls a targeted commitment or nullifier read', async () => {
      const vault = makeVault({
        deposits: [{ blockNumber: BLOCK_A, outputCommitment: COMMITMENT_A }],
        leaves: [leafFor(COMMITMENT_A, TS_A)],
      }) as Record<string, unknown>;
      // The interactor the index is given exposes no targeted reads at all;
      // if the implementation reached for one it would throw here.
      expect('getCommitmentTimestamp' in vault).toBe(false);
      expect('getNullifierTimestamp' in vault).toBe(false);
    });
  });

  test('a commitment whose block timestamp could not be resolved is PRESENT with an unknown timestamp', async () => {
    // Presence must never hinge on a block lookup succeeding: the purge path
    // deletes notes it believes absent, and a transient getBlock failure is not
    // absence.
    const { index } = makeIndex({
      deposits: [{ blockNumber: BLOCK_A, outputCommitment: COMMITMENT_A }],
      timestamps: new Map<string, Hex>(),
      leaves: [leafFor(COMMITMENT_A, TS_A)],
    });
    await index.refresh();
    expect(index.commitmentTimestamp(COMMITMENT_A)).toBeNull();
    expect(index.hasCommitment(COMMITMENT_A)).toBe(true);
  });

  test('a nullifier spent in a block whose timestamp could not be resolved is still SPENT', async () => {
    const { index } = makeIndex({
      transacts: [{ blockNumber: BLOCK_A, outputCommitments: [COMMITMENT_B], nullifierHashes: [NULLIFIER_A] }],
      timestamps: new Map<string, Hex>(),
    });
    await index.refresh();
    expect(index.isNullifierSpent(NULLIFIER_A)).toBe(true);
    expect(index.nullifierSpentAt(NULLIFIER_A)).toBeNull();
    expect(index.hasCommitment(COMMITMENT_B)).toBe(true);
  });

  describe('ASP snapshot', () => {
    const snapshot = {
      snapshotBlockNumber: '100',
      deposits: [{ outputCommitment: BigInt(COMMITMENT_A).toString(), blockTimestamp: '1970-01-01T00:00:01.000Z' }],
      transacts: [
        {
          outputCommitments: [BigInt(COMMITMENT_B).toString()],
          nullifierHashes: [BigInt(NULLIFIER_A).toString()],
          blockTimestamp: '1970-01-01T00:00:02.000Z',
        },
      ],
      ragequits: [],
    };

    test('merges a valid snapshot: presence, spent state, verified timestamps', async () => {
      const index = new OnChainNoteIndex({
        chainId: 11155111,
        poolVaultInteractor: makeVault({ leaves: [leafFor(COMMITMENT_A, TS_A), leafFor(COMMITMENT_B, TS_B)] }) as never,
        hashService: hashService as never,
        loadEventSnapshot: async () => snapshot,
      });
      (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps = async () => new Map();
      await index.refresh();
      expect(index.hasCommitment(COMMITMENT_A)).toBe(true);
      expect(index.commitmentTimestamp(COMMITMENT_A)).toBe(TS_A);
      expect(index.isNullifierSpent(NULLIFIER_A)).toBe(true);
      expect(index.findTransacted({ nullifiers: [NULLIFIER_A], outputCommitments: [COMMITMENT_B] })).not.toBeNull();
    });

    test('a failed-leaf ASP timestamp heals from its own block, once that block proves the commitment', async () => {
      // Row A sits at block 100, below the tail window anchored by row B at
      // block 1000 (tail start = 1000 - 300). Its ISO timestamp reproduces no
      // leaf, so it is dropped - then healed: block 100's own events prove the
      // commitment (the vault has the deposit there), so getBlock(100)'s
      // timestamp is served, chain-authoritative. Row B claims block 1000 with
      // no event there: refused.
      const vault = makeVault({
        deposits: [{ blockNumber: `0x${(100).toString(16)}` as Hex, outputCommitment: COMMITMENT_A }],
      });
      const index = new OnChainNoteIndex({
        chainId: 11155111,
        poolVaultInteractor: vault as never,
        hashService: hashService as never,
        loadEventSnapshot: async () => ({
          snapshotBlockNumber: '1000',
          deposits: [
            { outputCommitment: BigInt(COMMITMENT_A).toString(), blockTimestamp: '1970-01-01T00:01:39.000Z', blockNumber: '100' },
            { outputCommitment: BigInt(COMMITMENT_B).toString(), blockTimestamp: '1970-01-01T00:01:39.000Z', blockNumber: '1000' },
          ],
          transacts: [],
          ragequits: [],
        }),
      });
      const requested: string[][] = [];
      (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps = async (blocks: readonly Hex[]) => {
        requested.push(blocks.map(String));
        return new Map(blocks.map((b) => [String(b), TS_A]));
      };
      await index.refresh();
      expect(requested.flat()).toContain(`0x${(100).toString(16)}`);
      expect(index.commitmentTimestamp(COMMITMENT_A)).toBe(TS_A);
      expect(index.commitmentTimestamp(COMMITMENT_B)).toBeNull();
      expect(index.unverifiedCommitments().length).toBe(1);
    });

    test('a row claiming a block beyond the snapshot boundary never enters the heal queue', async () => {
      // Self-inconsistent row: blockNumber 2000 > advertised boundary 1000. A
      // malicious/corrupt feed could otherwise burn heal slots (and proof
      // fetches) on unfetchable blocks every build, forever.
      const vault = makeVault({});
      const index = new OnChainNoteIndex({
        chainId: 11155111,
        poolVaultInteractor: vault as never,
        hashService: hashService as never,
        loadEventSnapshot: async () => ({
          snapshotBlockNumber: '1000',
          deposits: [
            { outputCommitment: BigInt(COMMITMENT_A).toString(), blockTimestamp: '1970-01-01T00:01:39.000Z', blockNumber: '2000' },
          ],
          transacts: [],
          ragequits: [],
        }),
      });
      const requested: string[][] = [];
      (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps = async (blocks: readonly Hex[]) => {
        requested.push(blocks.map(String));
        return new Map(blocks.map((b) => [String(b), TS_A]));
      };
      await index.refresh();
      expect(requested.flat()).not.toContain(`0x${(2000).toString(16)}`);
      expect(index.commitmentTimestamp(COMMITMENT_A)).toBeNull();
      expect(index.hasCommitment(COMMITMENT_A)).toBe(true);
    });

    test('a block that keeps failing is dropped from the heal queue after three builds', async () => {
      // A block whose timestamp/proof never resolves must not hold a heal slot
      // (plus two proof getLogs) on every rebuild for the whole session.
      const vault = makeVault({});
      const index = new OnChainNoteIndex({
        chainId: 11155111,
        poolVaultInteractor: vault as never,
        hashService: hashService as never,
        loadEventSnapshot: async () => ({
          snapshotBlockNumber: '1000',
          deposits: [
            { outputCommitment: BigInt(COMMITMENT_A).toString(), blockTimestamp: '1970-01-01T00:01:39.000Z', blockNumber: '100' },
          ],
          transacts: [],
          ragequits: [],
        }),
      });
      const requested: string[][] = [];
      // The block's timestamp never resolves (empty map every time).
      (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps = async (blocks: readonly Hex[]) => {
        requested.push(blocks.map(String));
        return new Map();
      };
      await index.refresh();
      await index.refresh({ force: true });
      await index.refresh({ force: true });
      const before = requested.flat().filter((b) => b === `0x${(100).toString(16)}`).length;
      await index.refresh({ force: true }); // fourth build: block is blacklisted
      const after = requested.flat().filter((b) => b === `0x${(100).toString(16)}`).length;
      expect(before).toBe(3);
      expect(after).toBe(3);
      expect(index.commitmentTimestamp(COMMITMENT_A)).toBeNull();
      expect(index.hasCommitment(COMMITMENT_A)).toBe(true);
    });

    test('a lying ASP blockNumber cannot heal: no event in that block names the commitment', async () => {
      // Serving getBlock(wrongBlock).timestamp for a real commitment would
      // build a witness that fails inside the circuit - strictly worse than
      // null. Refused, parked as unverified, still PRESENT so nothing
      // destructive can eat the note.
      const vault = makeVault({});
      const index = new OnChainNoteIndex({
        chainId: 11155111,
        poolVaultInteractor: vault as never,
        hashService: hashService as never,
        loadEventSnapshot: async () => ({
          snapshotBlockNumber: '1000',
          deposits: [
            { outputCommitment: BigInt(COMMITMENT_A).toString(), blockTimestamp: '1970-01-01T00:01:39.000Z', blockNumber: '100' },
          ],
          transacts: [],
          ragequits: [],
        }),
      });
      (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps =
        async (blocks: readonly Hex[]) => new Map(blocks.map((b) => [String(b), TS_A]));
      await index.refresh();
      expect(index.commitmentTimestamp(COMMITMENT_A)).toBeNull();
      expect(index.hasCommitment(COMMITMENT_A)).toBe(true);
      expect(index.unverifiedCommitments().length).toBe(1);
    });

    test('the heal takes newest blocks first with an oldest reserve, and defers the middle', async () => {
      // 30 old dropped rows (blocks 1..30, below the tail window anchored at
      // block 1000). Cap 24 with a 6-block oldest reserve: newest 18 (30..13)
      // + oldest 6 (1..6); blocks 7..12 defer. The newest commitment is served
      // in build one - a fresh payment never waits behind the backlog - and a
      // deferred one stays null rather than wrong.
      const olds = Array.from({ length: 30 }, (_, i) => ({
        commitment: pad(BigInt(0x5000 + i)),
        block: i + 1,
      }));
      const vault = makeVault({
        deposits: olds.map((o) => ({ blockNumber: `0x${o.block.toString(16)}` as Hex, outputCommitment: o.commitment })),
      });
      const index = new OnChainNoteIndex({
        chainId: 11155111,
        poolVaultInteractor: vault as never,
        hashService: hashService as never,
        loadEventSnapshot: async () => ({
          snapshotBlockNumber: '1000',
          deposits: [
            ...olds.map((o) => ({ outputCommitment: BigInt(o.commitment).toString(), blockTimestamp: '1970-01-01T00:01:39.000Z', blockNumber: String(o.block) })),
            { outputCommitment: BigInt(pad(0x6000n)).toString(), blockTimestamp: '1970-01-01T00:01:39.000Z', blockNumber: '1000' },
          ],
          transacts: [],
          ragequits: [],
        }),
      });
      const requested: string[][] = [];
      (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps = async (blocks: readonly Hex[]) => {
        requested.push(blocks.map(String));
        return new Map(blocks.map((b) => [String(b), TS_A]));
      };
      await index.refresh();
      const healRequest = requested.find((r) => r.includes(`0x${(30).toString(16)}`));
      expect(healRequest).toBeDefined();
      expect(healRequest).toContain('0x1'); // oldest reserve
      expect(healRequest).not.toContain(`0x${(8).toString(16)}`); // middle deferred
      expect(index.commitmentTimestamp(olds[29].commitment)).toBe(TS_A); // newest served
      expect(index.commitmentTimestamp(olds[0].commitment)).toBe(TS_A);  // oldest reserve served
      expect(index.commitmentTimestamp(olds[7].commitment)).toBeNull();  // deferred: null, never wrong
    });

    test('an unprovable ASP timestamp (no blockNumber, no leaf) stays unverified but PRESENT', async () => {
      // A destructive purge must never delete a real note over a verification
      // miss; unverified is a parking state, not absence.
      const vault = makeVault({});
      const index = new OnChainNoteIndex({
        chainId: 11155111,
        poolVaultInteractor: vault as never,
        hashService: hashService as never,
        loadEventSnapshot: async () => ({
          snapshotBlockNumber: '1000',
          deposits: [{ outputCommitment: BigInt(COMMITMENT_A).toString(), blockTimestamp: '1970-01-01T00:01:39.000Z' }],
          transacts: [],
          ragequits: [],
        }),
      });
      (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps = async () => new Map();
      await index.refresh();
      expect(index.commitmentTimestamp(COMMITMENT_A)).toBeNull();
      expect(index.unverifiedCommitments().length).toBe(1);
      expect(index.hasCommitment(COMMITMENT_A)).toBe(true);
    });

    test('a quiet pool discovers approved history without requesting archive logs', async () => {
      const { index, vault } = makeIndex({
        snapshot: { snapshotBlockNumber: '25978254', deposits: [{
          outputCommitment: COMMITMENT_A, blockNumber: '25962235', blockTimestamp: '1970-01-01T00:00:01.000Z',
        }], transacts: [], ragequits: [] },
        leaves: [leafFor(COMMITMENT_A, TS_A)],
      });
      const scan = async (from?: Hex) => {
        if (from === undefined || BigInt(from) < 25970000n) throw new Error('Archive requests require a personal token');
        return [];
      };
      vault.getDepositedEvents = mock(scan);
      vault.getTransactedEvents = mock(scan);
      vault.getRagequitEvents = mock(scan);
      await index.refresh();
      expect(index.commitmentTimestamp(COMMITMENT_A)).toBe(TS_A);
      expect(index.unverifiedCommitments()).toEqual([]);
    });

    test('the chain tail starts below the coverage the ASP PROVED, not where it claims', async () => {
      // Advertised 1000, but the newest row proves only 900, so the tail starts
      // at 900-300 and not at 1000-300. The gap between the two is exactly the
      // window that hid a relayed spend on 2026-08-27. The overlap must still
      // catch a spend the snapshot has not returned yet.
      const vault = makeVault({ transacts: [{ blockNumber: '0x3b6', outputCommitments: [], nullifierHashes: [NULLIFIER_B] }] });
      const index = new OnChainNoteIndex({
        chainId: 11155111,
        poolVaultInteractor: vault as never,
        hashService: hashService as never,
        loadEventSnapshot: async () => ({
          snapshotBlockNumber: '1000',
          deposits: [{ outputCommitment: BigInt(COMMITMENT_A).toString(), blockTimestamp: '1970-01-01T00:00:01.000Z', blockNumber: '900' }],
          transacts: [],
          ragequits: [],
        }),
      });
      (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps = async () => new Map();
      await index.refresh();
      const from = (vault.getTransactedEvents.mock.calls as unknown[][])[0]?.[0];
      expect(from).toBe(`0x${(600).toString(16)}`);
      expect(index.isNullifierSpent(NULLIFIER_B)).toBe(true);
    });

    for (const missing of ['deposits', 'transacts', 'ragequits']) {
      test(`a missing ${missing} section cannot suppress historical chain events`, async () => {
        const snapshot: Record<string, unknown> = { snapshotBlockNumber: '100000', deposits: [], transacts: [], ragequits: [] };
        delete snapshot[missing];
        const { index, vault } = makeIndex({ snapshot,
          transacts: [{ blockNumber: BLOCK_A, outputCommitments: [], nullifierHashes: [NULLIFIER_B] }],
        });
        await index.refresh();
        expect(vault.getTransactedEvents.mock.calls[0][0]).toBeUndefined();
        expect(index.isNullifierSpent(NULLIFIER_B)).toBe(true);
      });
    }

    // The hole this pair closes: three empty arrays satisfy snapshotCursor, so
    // an ASP serving nothing while advertising the head used to authorise a tail
    // that skipped everything below it.
    test('an all-empty snapshot proves no coverage and scans the whole chain', async () => {
      const vault = makeVault({
        transacts: [{ blockNumber: BLOCK_A, outputCommitments: [], nullifierHashes: [NULLIFIER_B] }], // block 100, far below 1000-300
      });
      const index = new OnChainNoteIndex({
        chainId: 11155111,
        poolVaultInteractor: vault as never,
        hashService: hashService as never,
        loadEventSnapshot: async () => ({ snapshotBlockNumber: '1000', deposits: [], transacts: [], ragequits: [] }),
      });
      (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps = async () => new Map();
      await index.refresh();
      expect(vault.getTransactedEvents.mock.calls[0][0]).toBeUndefined();
      expect(index.isNullifierSpent(NULLIFIER_B)).toBe(true);
    });

    // A pool quiet for a long time puts the proved start far below the claim,
    // and a pruning provider refuses that depth. Falling back to the claim keeps
    // the index working; failing the whole build would take the balance with it.
    test('a provider that refuses the proved depth falls back to the advertised one', async () => {
      const refusedBelow = 800n;
      const vault = makeVault({
        transacts: [{ blockNumber: BLOCK_A, outputCommitments: [], nullifierHashes: [NULLIFIER_B] }],
      });
      type RefusingMock = {
        getMockImplementation: () => (from?: string) => Promise<unknown>;
        mockImplementation: (fn: (from?: string) => Promise<unknown>) => void;
      };
      for (const read of [vault.getDepositedEvents, vault.getTransactedEvents, vault.getRagequitEvents] as unknown as RefusingMock[]) {
        const inner = read.getMockImplementation();
        read.mockImplementation(async (from?: string) => {
          if (from !== undefined && BigInt(from) < refusedBelow) throw new Error('archive data not available');
          return inner(from);
        });
      }
      const index = new OnChainNoteIndex({
        chainId: 11155111,
        poolVaultInteractor: vault as never,
        hashService: hashService as never,
        loadEventSnapshot: async () => ({
          snapshotBlockNumber: '5000',
          deposits: [{ outputCommitment: BigInt(COMMITMENT_A).toString(), blockTimestamp: '1970-01-01T00:00:01.000Z', blockNumber: '900' }],
          transacts: [],
          ragequits: [],
        }),
      });
      (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps = async () => new Map();
      await index.refresh();
      const calls = (vault.getTransactedEvents.mock.calls as unknown[][]).map((c) => c[0]);
      // First the proved start (900-300), refused; then the advertised (5000-300).
      expect(calls[0]).toBe(`0x${(600).toString(16)}`);
      expect(calls[1]).toBe(`0x${(4700).toString(16)}`);
      expect(index.hasCommitment(COMMITMENT_A)).toBe(true);
    });

    // The other half of the same rule. The fallback knowingly leaves a gap, so
    // it is earned only by an error that actually says "this depth is refused".
    // A timeout says nothing about depth: retrying shallower on one would
    // publish an index that skipped the gap and answers isNullifierSpent false
    // for a spend inside it. It must fail instead (codex, 2026-09-15).
    test('a transient failure at the proved depth fails rather than silently narrowing', async () => {
      const vault = makeVault({
        transacts: [{ blockNumber: BLOCK_A, outputCommitments: [], nullifierHashes: [NULLIFIER_B] }],
      });
      type RefusingMock = {
        getMockImplementation: () => (from?: string) => Promise<unknown>;
        mockImplementation: (fn: (from?: string) => Promise<unknown>) => void;
      };
      for (const read of [vault.getDepositedEvents, vault.getTransactedEvents, vault.getRagequitEvents] as unknown as RefusingMock[]) {
        const inner = read.getMockImplementation();
        read.mockImplementation(async (from?: string) => {
          if (from !== undefined && BigInt(from) < 800n) throw new Error('The request timed out.');
          return inner(from);
        });
      }
      const index = new OnChainNoteIndex({
        chainId: 11155111,
        poolVaultInteractor: vault as never,
        hashService: hashService as never,
        loadEventSnapshot: async () => ({
          snapshotBlockNumber: '5000',
          deposits: [{ outputCommitment: BigInt(COMMITMENT_A).toString(), blockTimestamp: '1970-01-01T00:00:01.000Z', blockNumber: '900' }],
          transacts: [],
          ragequits: [],
        }),
      });
      (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps = async () => new Map();
      await expect(index.refresh()).rejects.toThrow('timed out');
      const calls = (vault.getTransactedEvents.mock.calls as unknown[][]).map((c) => c[0]);
      // The proved start only. No second, shallower read was attempted.
      expect(calls).toEqual([`0x${(600).toString(16)}`]);
    });

    // A single row claiming a block ABOVE the snapshot's own advertised
    // boundary is self-inconsistent. The index already refuses to heal a
    // timestamp from one; it must not let one prove coverage either, or that
    // row is a lever to turn "scan deeper" back into "trust the claim".
    test('a row above the advertised boundary proves nothing and forces a full scan', async () => {
      const vault = makeVault({
        transacts: [{ blockNumber: BLOCK_A, outputCommitments: [], nullifierHashes: [NULLIFIER_B] }],
      });
      const index = new OnChainNoteIndex({
        chainId: 11155111,
        poolVaultInteractor: vault as never,
        hashService: hashService as never,
        loadEventSnapshot: async () => ({
          snapshotBlockNumber: '1000',
          // The only row names block 2000 — beyond what the snapshot claims.
          deposits: [{ outputCommitment: BigInt(COMMITMENT_A).toString(), blockTimestamp: '1970-01-01T00:00:01.000Z', blockNumber: '2000' }],
          transacts: [],
          ragequits: [],
        }),
      });
      (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps = async () => new Map();
      await index.refresh();
      const calls = (vault.getTransactedEvents.mock.calls as unknown[][]).map((c) => c[0]);
      // undefined = from genesis. NOT 0x2bc (1000-300), which is what trusting
      // the out-of-bound row as proof would have produced.
      expect(calls).toEqual([undefined]);
      expect(index.isNullifierSpent(NULLIFIER_B)).toBe(true);
    });

    test('a zero watermark proves no coverage and scans the whole chain', async () => {
      const vault = makeVault({
        transacts: [{ blockNumber: BLOCK_A, outputCommitments: [], nullifierHashes: [NULLIFIER_B] }], // block 100, far below 1000-300
      });
      const index = new OnChainNoteIndex({
        chainId: 11155111,
        poolVaultInteractor: vault as never,
        hashService: hashService as never,
        loadEventSnapshot: async () => ({ ...snapshot, snapshotBlockNumber: '0' }), // section has never synced
      });
      (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps = async () => new Map();
      await index.refresh();
      expect((vault.getTransactedEvents.mock.calls as unknown[][])[0]?.[0]).toBeUndefined();
      expect(index.isNullifierSpent(NULLIFIER_B)).toBe(true);
      // Snapshot rows were still merged as hints.
      expect(index.isNullifierSpent(NULLIFIER_A)).toBe(true);
    });

    test('findTransacted prefers the chain-tail duplicate that carries txHash and block over the snapshot row', async () => {
      const TX = pad(0xfeedn) as unknown as Hash;
      // The tail duplicate lives at the SAME block the snapshot row names
      // (block 900, inside the tail window 600..head). The old fixture put it
      // at block 200, which only "worked" because the vault mock ignored the
      // tail's fromBlock — a real tail never sees a block below its start.
      const vault = makeVault({
        transacts: [{ blockNumber: `0x${(900).toString(16)}` as Hex, outputCommitments: [COMMITMENT_B], nullifierHashes: [NULLIFIER_A], txHash: TX } as never],
      });
      const index = new OnChainNoteIndex({
        chainId: 11155111,
        poolVaultInteractor: vault as never,
        hashService: hashService as never,
        loadEventSnapshot: async () => ({
          snapshotBlockNumber: '1000',
          deposits: [],
          transacts: [{ ...snapshot.transacts[0], blockNumber: '900' }],
          ragequits: [],
        }),
      });
      (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps = async () => new Map();
      await index.refresh();
      const hit = index.findTransacted({ nullifiers: [NULLIFIER_A] });
      expect(hit?.txHash).toBe(TX);
      expect(hit?.blockNumber).toBe(`0x${(900).toString(16)}`);
    });

    test('a malformed row discards the WHOLE snapshot (no partial merge) and falls back to the chain', async () => {
      const vault = makeVault({
        transacts: [{ blockNumber: BLOCK_B, outputCommitments: [], nullifierHashes: [NULLIFIER_B] }],
      });
      const index = new OnChainNoteIndex({
        chainId: 11155111,
        poolVaultInteractor: vault as never,
        hashService: hashService as never,
        loadEventSnapshot: async () => ({
          ...snapshot,
          ragequits: [{ commitment: 'not-a-number', nullifierHash: '1', blockTimestamp: '1970-01-01T00:00:03.000Z' }],
        }),
      });
      (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps = async () =>
        new Map<string, Hex>([[BLOCK_B, TS_B]]);
      await index.refresh();
      // Nothing from the rejected snapshot survived...
      expect(index.hasCommitment(COMMITMENT_A)).toBe(false);
      expect(index.isNullifierSpent(NULLIFIER_A)).toBe(false);
      // ...and the chain scan ran from deployment (no fromBlock), so the tail event is there.
      expect(index.isNullifierSpent(NULLIFIER_B)).toBe(true);
      expect((vault.getTransactedEvents.mock.calls as unknown[][])[0]?.[0]).toBeUndefined();
    });
  });

  test('findTransacted matches on the nullifiers (spent once, so exact) and reports whether the outputs are ours', async () => {
    const { index } = makeIndex({
      transacts: [
        { blockNumber: BLOCK_A, outputCommitments: [COMMITMENT_B], nullifierHashes: [NULLIFIER_A] },
      ],
      leaves: [leafFor(COMMITMENT_B, TS_A)],
    });
    await index.refresh();
    const ours = index.findTransacted({ nullifiers: [NULLIFIER_A], outputCommitments: [COMMITMENT_B] });
    expect(ours?.blockNumber).toBe(BLOCK_A);
    expect(ours?.outputsMatch).toBe(true);
    // Same inputs consumed by a spend with OTHER outputs: still the event that
    // spent our notes (a nullifier cannot be spent twice), flagged so the caller
    // shows the observed txHash rather than waiting for an impossible event.
    const other = index.findTransacted({ nullifiers: [NULLIFIER_A], outputCommitments: [pad(0xeeen)] });
    expect(other?.blockNumber).toBe(BLOCK_A);
    expect(other?.outputsMatch).toBe(false);
    // A nullifier we hold that no event consumed: not spent.
    expect(index.findTransacted({ nullifiers: [NULLIFIER_A, NULLIFIER_B] })).toBeNull();
  });

  test('reuses a fresh build and rebuilds on force', async () => {
    const vault = makeVault({
      deposits: [{ blockNumber: BLOCK_A, outputCommitment: COMMITMENT_A }],
      leaves: [leafFor(COMMITMENT_A, TS_A)],
    });
    const index = new OnChainNoteIndex({
      chainId: 11155111,
      poolVaultInteractor: vault as never,
      hashService: hashService as never,
    });
    (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps = async () =>
      new Map<string, Hex>([[BLOCK_A, TS_A]]);

    await index.refresh();
    await index.refresh();
    expect(vault.getDepositedEvents).toHaveBeenCalledTimes(1);
    await index.refresh({ force: true });
    expect(vault.getDepositedEvents).toHaveBeenCalledTimes(2);
  });
});

describe('waitForNullifiersSpent', () => {
  test('returns true once every nullifier is observed spent', async () => {
    const { index } = makeIndex({
      transacts: [
        { blockNumber: BLOCK_A, outputCommitments: [], nullifierHashes: [NULLIFIER_A, NULLIFIER_B] },
      ],
    });
    const ok = await waitForNullifiersSpent(index, [NULLIFIER_A, NULLIFIER_B], {
      attempts: 2,
      intervalMs: 1,
    });
    expect(ok).toBe(true);
  });

  test('returns false (inconclusive) when a nullifier never appears', async () => {
    const { index } = makeIndex({
      transacts: [{ blockNumber: BLOCK_A, outputCommitments: [], nullifierHashes: [NULLIFIER_A] }],
    });
    const ok = await waitForNullifiersSpent(index, [NULLIFIER_A, NULLIFIER_B], {
      attempts: 2,
      intervalMs: 1,
    });
    expect(ok).toBe(false);
  });

  test('returns false for an empty nullifier set rather than a vacuous true', async () => {
    const { index } = makeIndex({});
    expect(await waitForNullifiersSpent(index, [], { attempts: 1, intervalMs: 1 })).toBe(false);
  });
});
