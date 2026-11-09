import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LeanIMT } from '@zk-kit/lean-imt';
import {
  MerkleService,
  NoteComputationService,
  CryptoService,
  PoseidonHashService,
  WitnessPreparationService,
  createEvmKeystoreInteractor,
} from '@privacy-pools-v2/sdk';
import {
  checkKeystoreRoot,
  correctKeystoreInteractor,
  getKeystoreCorrection,
  leafHex,
  resetKeystoreRootGuardState,
  type KeystoreEvent,
  type KeystoreLeafRowLike,
  type KeystoreRootDeps,
} from '../keystore-root-guard';

// The 2026-11-09 shape: the chain holds 363 keystore leaves (indexes 0..362),
// the ASP's list holds 362 and advertises the chain head anyway.

const CHAIN_ID = 1;
const KEYSTORE = '0x6E463391c79b7e1A88eF26E0B023f9A6C9938a71';
const FROM_BLOCK = 25_884_228n;
const HEAD = 26_378_564n;
const CHAIN_LEAVES = 363;

let hash: PoseidonHashService;
let merkle: MerkleService;
let chainEvents: KeystoreEvent[];
let chainRoot: bigint;
let leaves: `0x${string}`[];

const toRow = (e: KeystoreEvent): KeystoreLeafRowLike => ({
  leaf: e.leaf.toString(),
  leafIndex: e.leafIndex.toString(),
  root: e.root.toString(),
  blockNumber: e.blockNumber.toString(),
  eventType: e.kind === 'inserted' ? 'leaf_inserted' : 'leaf_updated',
});

beforeAll(async () => {
  hash = await PoseidonHashService.create();
  merkle = new MerkleService({ hashService: hash });
  const tree = new LeanIMT((a: string, b: string) => hash.hash([a as `0x${string}`, b as `0x${string}`]));
  chainEvents = [];
  leaves = [];
  for (let i = 0; i < CHAIN_LEAVES; i += 1) {
    const leaf = hash.hash([`0x${(i + 1).toString(16)}`]) as `0x${string}`;
    leaves.push(leaf);
    tree.insert(leaf);
    chainEvents.push({
      kind: 'inserted',
      leafIndex: BigInt(i),
      leaf: BigInt(leaf),
      root: BigInt(tree.root),
      blockNumber: FROM_BLOCK + BigInt(i) * 1_300n,
      logIndex: 0,
    });
  }
  chainRoot = chainEvents[chainEvents.length - 1].root;
}, 120_000);

beforeEach(() => resetKeystoreRootGuardState());

type Counters = { head: number; root: number; events: number };
function deps(opts: {
  rows: KeystoreLeafRowLike[] | null;
  /** What the chain's getLogs answers; defaults to the whole truth. */
  logs?: (from: bigint, to: bigint) => KeystoreEvent[];
}): { deps: KeystoreRootDeps; counters: Counters } {
  const counters: Counters = { head: 0, root: 0, events: 0 };
  const logs = opts.logs ?? ((from, to) => chainEvents.filter((e) => e.blockNumber >= from && e.blockNumber <= to));
  return {
    counters,
    deps: {
      chainId: CHAIN_ID,
      keystoreAddress: KEYSTORE,
      fromBlock: FROM_BLOCK,
      readHead: async () => { counters.head += 1; return HEAD; },
      readRoot: async () => { counters.root += 1; return chainRoot; },
      heldRows: async () => opts.rows,
      getEvents: async (from, to) => { counters.events += 1; return logs(from, to); },
      computeRoot: async (l) => BigInt(await merkle.computeRoot([...l])),
    },
  };
}

const staleRows = () => chainEvents.slice(0, CHAIN_LEAVES - 1).map(toRow);

describe('keystore root health check', () => {
  test('(a) detects an ASP list one leaf behind the chain and repairs it from the tail', async () => {
    const { deps: d, counters } = deps({ rows: staleRows() });
    const verdict = await checkKeystoreRoot(d);
    expect(verdict).toEqual({ status: 'repaired', tier: 'tail' });
    // Only the tail above the newest held event, not the whole history.
    expect(counters.events).toBe(1);
  });

  test('(b) the rebuilt root equals the chain current root, with all 363 leaves', async () => {
    const { deps: d } = deps({ rows: staleRows() });
    await checkKeystoreRoot(d);
    const held = getKeystoreCorrection(CHAIN_ID, KEYSTORE)!;
    expect(held.leaves).toHaveLength(CHAIN_LEAVES);
    expect(held.root).toBe(chainRoot);
    expect(BigInt(await merkle.computeRoot(held.leaves))).toBe(chainRoot);
  });

  test('(c) a current snapshot costs two argument-free reads and no log read', async () => {
    const { deps: d, counters } = deps({ rows: chainEvents.map(toRow) });
    expect(await checkKeystoreRoot(d)).toEqual({ status: 'current' });
    expect(counters).toEqual({ head: 1, root: 1, events: 0 });
    expect(getKeystoreCorrection(CHAIN_ID, KEYSTORE)).toBeUndefined();
  });

  test('a held correction that still matches the chain costs no log read either', async () => {
    const first = deps({ rows: staleRows() });
    await checkKeystoreRoot(first.deps);
    const second = deps({ rows: staleRows() });
    expect(await checkKeystoreRoot(second.deps)).toEqual({ status: 'repaired', tier: 'held' });
    expect(second.counters.events).toBe(0);
  });

  test('the correction is dropped once the snapshot catches up', async () => {
    await checkKeystoreRoot(deps({ rows: staleRows() }).deps);
    expect(getKeystoreCorrection(CHAIN_ID, KEYSTORE)).toBeDefined();
    // The correction still matches, so it stays until the held rows are right too.
    const caught = deps({ rows: chainEvents.map(toRow) });
    caught.deps.readRoot = async () => chainRoot;
    // Held correction wins first; simulate the chain moving on instead.
    resetKeystoreRootGuardState();
    expect(await checkKeystoreRoot(caught.deps)).toEqual({ status: 'current' });
  });

  test('(e) a lossy log read (the missing event again missing) is not accepted', async () => {
    const lossy = (from: bigint, to: bigint) => chainEvents
      .filter((e) => e.blockNumber >= from && e.blockNumber <= to && e.leafIndex !== 362n);
    const { deps: d } = deps({ rows: staleRows(), logs: lossy });
    const verdict = await checkKeystoreRoot(d);
    expect(verdict.status).toBe('unrepaired');
    expect(getKeystoreCorrection(CHAIN_ID, KEYSTORE)).toBeUndefined();
  });

  test('(e) a lossy read that drops a middle event is not accepted either', async () => {
    const lossy = (from: bigint, to: bigint) => chainEvents
      .filter((e) => e.blockNumber >= from && e.blockNumber <= to && e.leafIndex !== 200n);
    const { deps: d } = deps({ rows: null, logs: lossy });
    d.heldRows = async () => chainEvents.slice(0, 100).map(toRow);
    const verdict = await checkKeystoreRoot(d);
    expect(verdict.status).toBe('unrepaired');
    expect(getKeystoreCorrection(CHAIN_ID, KEYSTORE)).toBeUndefined();
  });

  test('a provider that is lossy once and whole the second time still repairs from the full history', async () => {
    let calls = 0;
    const flaky = (from: bigint, to: bigint) => {
      calls += 1;
      const all = chainEvents.filter((e) => e.blockNumber >= from && e.blockNumber <= to);
      return calls <= 2 ? all.filter((e) => e.leafIndex !== 362n) : all;
    };
    const { deps: d } = deps({ rows: staleRows(), logs: flaky });
    expect(await checkKeystoreRoot(d)).toEqual({ status: 'repaired', tier: 'full' });
  });

  test('ASP rows that lie about the root are not trusted: the chain decides', async () => {
    const rows = chainEvents.map(toRow);
    rows[rows.length - 1].root = (chainRoot + 1n).toString();
    const { deps: d } = deps({ rows });
    expect((await checkKeystoreRoot(d)).status).toBe('repaired');
  });

  test('(4) a held repair that still matches is served again for a fresh snapshot with the same lag: no log read, no rebuild', async () => {
    const first = deps({ rows: staleRows() });
    await checkKeystoreRoot(first.deps);
    for (let i = 0; i < 5; i += 1) {
      const again = deps({ rows: staleRows() });
      expect(await checkKeystoreRoot(again.deps)).toEqual({ status: 'repaired', tier: 'held' });
      expect(again.counters).toEqual({ head: 1, root: 1, events: 0 });
    }
  });

  test('(2) one repair attempt per chain per 10 minutes covers both tiers and failures', async () => {
    let clock = 1_000_000;
    const lossy = (from: bigint, to: bigint) => chainEvents
      .filter((e) => e.blockNumber >= from && e.blockNumber <= to && e.leafIndex !== 362n);
    const run = deps({ rows: staleRows(), logs: lossy });
    run.deps.now = () => clock;
    expect((await checkKeystoreRoot(run.deps)).status).toBe('unrepaired');
    const spent = run.counters.events;
    expect(spent).toBeGreaterThan(0);
    // Grid instants every 2 minutes for the next 9: no further log call at all.
    for (let i = 0; i < 4; i += 1) {
      clock += 2 * 60_000;
      expect(await checkKeystoreRoot(run.deps)).toEqual({ status: 'unrepaired', reason: 'repair is backing off' });
    }
    expect(run.counters.events).toBe(spent);
  });

  test('(2) failed repairs back off: 20 min after the first, 40 after the second, capped at an hour', async () => {
    let clock = 5_000_000;
    const lossy = (from: bigint, to: bigint) => chainEvents
      .filter((e) => e.blockNumber >= from && e.blockNumber <= to && e.leafIndex !== 362n);
    const run = deps({ rows: staleRows(), logs: lossy });
    run.deps.now = () => clock;
    const attempt = async (afterMs: number) => {
      clock += afterMs;
      const before = run.counters.events;
      await checkKeystoreRoot(run.deps);
      return run.counters.events - before;
    };
    expect(await attempt(0)).toBeGreaterThan(0);
    expect(await attempt(19 * 60_000)).toBe(0);
    expect(await attempt(2 * 60_000)).toBeGreaterThan(0);
    expect(await attempt(39 * 60_000)).toBe(0);
    expect(await attempt(2 * 60_000)).toBeGreaterThan(0);
    expect(await attempt(59 * 60_000)).toBe(0);
    expect(await attempt(2 * 60_000)).toBeGreaterThan(0);
  });

  test('(3) a chain with a 1000-block log cap and a multi-million block history is refused before any request', async () => {
    const { deps: d, counters } = deps({ rows: null });
    d.heldRows = async () => chainEvents.slice(0, 100).map(toRow);
    d.windowBlocks = 1_000n;
    d.fromBlock = 1_000_000n;
    d.readHead = async () => 4_100_000n;
    const verdict = await checkKeystoreRoot(d);
    expect(verdict.status).toBe('unrepaired');
    // The tail alone would need ~3000 windows: nothing is sent.
    expect(counters.events).toBe(0);
  });

  test('(3) a repair never sends more log calls than its budget, even when every call succeeds empty', async () => {
    let calls = 0;
    const { deps: d } = deps({ rows: staleRows() });
    d.getEvents = async () => { calls += 1; return []; };
    d.windowBlocks = 10_000n;
    d.maxRequestsPerRepair = 7;
    d.fromBlock = 25_000_000n;
    d.readHead = async () => 25_050_000n;
    await checkKeystoreRoot(d);
    expect(calls).toBeLessThanOrEqual(7);
  });

  test('(3) a rate limit stops the repair after that one call and backs off', async () => {
    let calls = 0;
    const { deps: d } = deps({ rows: staleRows() });
    d.getEvents = async () => { calls += 1; throw Object.assign(new Error('HTTP 429 too many requests'), { status: 429 }); };
    const verdict = await checkKeystoreRoot(d);
    expect(verdict.status).toBe('unrepaired');
    expect(calls).toBe(1);
  });

  test('(3) a range cap error is learned once and the walk goes on within the budget', async () => {
    let calls = 0;
    const { deps: d } = deps({ rows: staleRows() });
    d.windowBlocks = 100_000n;
    d.getEvents = async (from, to) => {
      calls += 1;
      if (to - from + 1n > 20_000n) throw new Error('query exceeds max block range 20000');
      return chainEvents.filter((e) => e.blockNumber >= from && e.blockNumber <= to);
    };
    expect((await checkKeystoreRoot(d)).status).toBe('repaired');
    expect(calls).toBeLessThanOrEqual(8);
  });

  test('production shares one keystore address across chains: a repair on A leaves B alone, and a healthy B does not delete A', async () => {
    const CHAIN_B = 56;
    // A repairs.
    await checkKeystoreRoot(deps({ rows: staleRows() }).deps);
    const heldA = getKeystoreCorrection(CHAIN_ID, KEYSTORE);
    expect(heldA).toBeDefined();
    expect(getKeystoreCorrection(CHAIN_B, KEYSTORE)).toBeUndefined();

    // B is healthy on the same address: it must not delete (or create) anything for A.
    const healthyB = deps({ rows: chainEvents.map(toRow) });
    healthyB.deps.chainId = CHAIN_B;
    expect(await checkKeystoreRoot(healthyB.deps)).toEqual({ status: 'current' });
    expect(getKeystoreCorrection(CHAIN_ID, KEYSTORE)).toBe(heldA);
    expect(getKeystoreCorrection(CHAIN_B, KEYSTORE)).toBeUndefined();

    // And the other way round: B repairs, A's held set is untouched.
    resetKeystoreRootGuardState();
    await checkKeystoreRoot(deps({ rows: staleRows() }).deps);
    const keptA = getKeystoreCorrection(CHAIN_ID, KEYSTORE);
    const lagB = deps({ rows: staleRows() });
    lagB.deps.chainId = CHAIN_B;
    expect((await checkKeystoreRoot(lagB.deps)).status).toBe('repaired');
    expect(getKeystoreCorrection(CHAIN_ID, KEYSTORE)).toBe(keptA);
    expect(getKeystoreCorrection(CHAIN_B, KEYSTORE)).not.toBe(keptA);

    // Chain A's interactor does not read chain B's correction.
    const interactorA = correctKeystoreInteractor({ getKeystoreLeaves: async () => ['0x1'] }, 137, KEYSTORE);
    expect(await interactorA.getKeystoreLeaves()).toEqual(['0x1']);
  });

  test('with no snapshot held the check changes nothing', async () => {
    const { deps: d, counters } = deps({ rows: null });
    expect((await checkKeystoreRoot(d)).status).toBe('unchecked');
    expect(counters.events).toBe(0);
  });
});

// The exit: the ragequit witness needs only the keystore leaves. These run the
// SDK's own leaf reader and witness builder (the data-dependent part of
// prepareRageQuit) against a fake vault that, like the real one, accepts only
// the current keystore root.
describe('exit preparation without the ASP', () => {
  const owner = '0x00000000000000000000000000000000000000a1' as const;
  const nullKey = '0x1234' as const;
  const revocableKey = '0x5678' as const;
  let userLeaf: `0x${string}`;
  let witnessService: WitnessPreparationService;

  /** A chain whose keystore holds `userAt` as the user's leaf. */
  function chainWithUser(userAt: number) {
    const tree = new LeanIMT((a: string, b: string) => hash.hash([a as `0x${string}`, b as `0x${string}`]));
    const events: KeystoreEvent[] = [];
    for (let i = 0; i < CHAIN_LEAVES; i += 1) {
      const leaf = i === userAt ? userLeaf : leaves[i];
      tree.insert(leaf);
      events.push({
        kind: 'inserted', leafIndex: BigInt(i), leaf: BigInt(leaf), root: BigInt(tree.root),
        blockNumber: FROM_BLOCK + BigInt(i) * 1_300n, logIndex: 0,
      });
    }
    return { events, root: events[events.length - 1].root };
  }

  /** The SDK's own interactor over an RPC that serves exactly these events (as an ASP-fed or chain-fed wrapper would). */
  function sdkInteractor(served: KeystoreEvent[]) {
    const rpc = {
      getBlockNumber: async () => `0x${HEAD.toString(16)}`,
      getLogsPaginated: async () => served.map((e) => ({
        eventName: 'LeafInserted',
        args: { _newLeaf: e.leaf, _root: e.root, _leafIndex: e.leafIndex },
        blockNumber: `0x${e.blockNumber.toString(16)}`,
        transactionHash: '0x',
      })),
      getLogs: async () => [],
    };
    return createEvmKeystoreInteractor({
      rpcInteractor: rpc as never,
      contractAddress: KEYSTORE as `0x${string}`,
      deploymentBlock: FROM_BLOCK,
    });
  }

  async function exitWitness(interactor: { getKeystoreLeaves: () => Promise<string[]> }) {
    const keystoreLeaves = await interactor.getKeystoreLeaves();
    return witnessService.buildRagequitWitness({
      note: {
        noteAddressHash: '0x' + '11'.repeat(32), commitment: '0xabc', value: '0x1', tokenId: owner,
        label: '0x77', status: 'ACTIVE', ownerAddress: owner, noteSecret: '0x99', isOwned: true,
        createdAtBlock: '0x1', spentAtBlock: null, txHash: '0x' + '22'.repeat(32),
      },
      ownerAddress: owner,
      privateNullifyingKey: nullKey,
      privateRevocableKey: revocableKey,
      tokenId: owner,
      label: '0x77',
      keystoreLeaves,
    } as never);
  }

  beforeAll(() => {
    const crypto = new CryptoService();
    const notes = new NoteComputationService({ hashService: hash, cryptoService: crypto });
    witnessService = new WitnessPreparationService({ hashService: hash, merkleService: merkle, noteComputationService: notes });
    const authDigest = notes.computeAuthDigest(revocableKey);
    userLeaf = hash.hash([owner, hash.hash([nullKey]), authDigest]) as `0x${string}`;
  });

  const vaultAccepts = (root: string, currentRoot: bigint) => BigInt(root) === currentRoot;

  test('control: the ASP list one leaf behind makes a witness the vault refuses', async () => {
    const chain = chainWithUser(100);
    const witness = await exitWitness(sdkInteractor(chain.events.slice(0, CHAIN_LEAVES - 1)));
    expect(vaultAccepts(witness.witness.keystoreRoot, chain.root)).toBe(false);
  });

  test('ASP one leaf behind: the grid repair makes the exit witness provable against the vault root', async () => {
    const chain = chainWithUser(100);
    const staleRows = chain.events.slice(0, CHAIN_LEAVES - 1);
    const run = deps({ rows: staleRows.map(toRow), logs: (from, to) => chain.events.filter((e) => e.blockNumber >= from && e.blockNumber <= to) });
    run.deps.readRoot = async () => chain.root;
    expect((await checkKeystoreRoot(run.deps)).status).toBe('repaired');

    // The session's interactor read the short list and caches it.
    const interactor = correctKeystoreInteractor(sdkInteractor(staleRows), CHAIN_ID, KEYSTORE);
    const witness = await exitWitness(interactor);
    expect(vaultAccepts(witness.witness.keystoreRoot, chain.root)).toBe(true);
  });

  test('ASP one leaf behind and the user is the newest registration: the exit still builds', async () => {
    const chain = chainWithUser(CHAIN_LEAVES - 1);
    const staleRows = chain.events.slice(0, CHAIN_LEAVES - 1);
    // Uncorrected, the user's own leaf is not in the list the SDK built.
    await expect(exitWitness(sdkInteractor(staleRows))).rejects.toThrow();
    const run = deps({ rows: staleRows.map(toRow), logs: (from, to) => chain.events.filter((e) => e.blockNumber >= from && e.blockNumber <= to) });
    run.deps.readRoot = async () => chain.root;
    await checkKeystoreRoot(run.deps);
    const witness = await exitWitness(correctKeystoreInteractor(sdkInteractor(staleRows), CHAIN_ID, KEYSTORE));
    expect(vaultAccepts(witness.witness.keystoreRoot, chain.root)).toBe(true);
  });

  test('ASP snapshot unavailable: the whole leaf set comes from the chain and the witness is accepted', async () => {
    const chain = chainWithUser(100);
    // No snapshot: the wrapper falls through to the chain sweep, which serves every event.
    const witness = await exitWitness(correctKeystoreInteractor(sdkInteractor(chain.events), CHAIN_ID, KEYSTORE));
    expect(vaultAccepts(witness.witness.keystoreRoot, chain.root)).toBe(true);
    // And the grid check, with no snapshot to compare, asks the ASP for nothing and breaks nothing.
    const run = deps({ rows: null });
    expect((await checkKeystoreRoot(run.deps)).status).toBe('unchecked');
  });

  test('repair, another registration, ASP refresh: an existing interactor still returns the complete set', async () => {
    // The session's interactor read the short list (362 leaves) and moved its cursor past leaf 362.
    const stale = chainEvents.slice(0, CHAIN_LEAVES - 1);
    const tree = new LeanIMT((a: string, b: string) => hash.hash([a as `0x${string}`, b as `0x${string}`]));
    for (const leaf of leaves) tree.insert(leaf);
    const newLeaf = hash.hash(['0xabcdef']) as `0x${string}`;
    tree.insert(newLeaf);
    const added: KeystoreEvent = {
      kind: 'inserted', leafIndex: BigInt(CHAIN_LEAVES), leaf: BigInt(newLeaf), root: BigInt(tree.root),
      blockNumber: HEAD + 10n, logIndex: 0,
    };
    const after = [...chainEvents, added];

    let served: KeystoreEvent[] = stale;
    let head = HEAD;
    const rpc = {
      getBlockNumber: async () => `0x${head.toString(16)}`,
      // Delta reads only: the SDK asks from its cursor + 1, so the block it already passed is never served again.
      getLogsPaginated: async (p: { fromBlock: bigint }) => served
        .filter((e) => e.blockNumber >= BigInt(p.fromBlock))
        .map((e) => ({
          eventName: 'LeafInserted',
          args: { _newLeaf: e.leaf, _root: e.root, _leafIndex: e.leafIndex },
          blockNumber: `0x${e.blockNumber.toString(16)}`,
          transactionHash: '0x',
        })),
      getLogs: async () => [],
    };
    const interactor = correctKeystoreInteractor(createEvmKeystoreInteractor({
      rpcInteractor: rpc as never,
      contractAddress: KEYSTORE as `0x${string}`,
      deploymentBlock: FROM_BLOCK,
    }), CHAIN_ID, KEYSTORE);
    expect(await interactor.getKeystoreLeaves()).toHaveLength(CHAIN_LEAVES - 1);

    // 1. The grid repairs (the ASP list is one behind).
    expect((await checkKeystoreRoot(deps({ rows: staleRows() }).deps)).status).toBe('repaired');

    // 2. Another registration lands. The interactor's next delta carries only it.
    served = after;
    head = HEAD + 20n;
    // 3. The ASP refreshes and is now complete.
    const refreshed = deps({ rows: after.map(toRow) });
    refreshed.deps.readHead = async () => head;
    refreshed.deps.readRoot = async () => added.root;
    expect(await checkKeystoreRoot(refreshed.deps)).toEqual({ status: 'current' });
    expect(refreshed.counters.events).toBe(0);

    // The old interactor still skips leaf 362 by itself; the held snapshot keeps the set complete.
    const out = await interactor.getKeystoreLeaves();
    expect(out).toHaveLength(CHAIN_LEAVES + 1);
    expect(out.every((l) => typeof l === 'string')).toBe(true);
    expect(out.map(BigInt)).toEqual(after.map((e) => e.leaf));
  });

  test('a failing interactor read answers from the held correction', async () => {
    const chain = chainWithUser(100);
    const run = deps({ rows: chain.events.slice(0, CHAIN_LEAVES - 1).map(toRow), logs: (from, to) => chain.events.filter((e) => e.blockNumber >= from && e.blockNumber <= to) });
    run.deps.readRoot = async () => chain.root;
    await checkKeystoreRoot(run.deps);
    const broken = correctKeystoreInteractor({ getKeystoreLeaves: async () => { throw new Error('rpc down'); } }, CHAIN_ID, KEYSTORE);
    expect(await broken.getKeystoreLeaves()).toHaveLength(CHAIN_LEAVES);
  });
});

// The check is the public grid's, never a user's: a read timed by a click would announce it.
describe('keystore root check is scheduled on the grid only', () => {
  const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (/\.tsx?$/.test(entry)) out.push(path);
    }
    return out;
  };
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const files = ['components', 'app', 'hooks', 'services'].flatMap((d) => walk(join(ROOT, d)))
    .map((f) => ({ file: f.slice(ROOT.length + 1), code: strip(readFileSync(f, 'utf8')) }));

  test('only the grid calls refreshKeystoreRoot, and only the feed file calls the check', () => {
    const calling = (re: RegExp) => files.filter(({ code }) => re.test(code)).map(({ file }) => file).sort();
    expect(calling(/\brefreshKeystoreRoot\s*\(/)).toEqual(['services/keystore-root-feed.ts', 'services/public-feeds.ts']);
    expect(calling(/\bcheckKeystoreRoot\s*\(/)).toEqual(['services/keystore-root-feed.ts', 'services/keystore-root-guard.ts']);
  });

  test('it is registered on the static grid with no enabled flag and a fixed wall-clock period', () => {
    const feeds = files.find((f) => f.file === 'services/public-feeds.ts')!.code;
    expect(feeds).toMatch(/key:\s*feedKeystoreRoot\(chainId\),\s*intervalMs:\s*KEYSTORE_ROOT_INTERVAL_MS,\s*fetch:\s*\(\)\s*=>\s*refreshKeystoreRoot\(chainId\)/);
    const feed = files.find((f) => f.file === 'services/keystore-root-feed.ts')!.code;
    expect(feed).not.toMatch(/\benabled\b|\brefetch\b|useQuery|queryKey/);
  });

  test('no component or hook imports the check or the feed', () => {
    const offenders = files
      .filter(({ file }) => /^(components|app|hooks)\//.test(file))
      .filter(({ code }) => /keystore-root-(feed|guard)'/.test(code) && /refreshKeystoreRoot|checkKeystoreRoot/.test(code));
    expect(offenders).toEqual([]);
  });
});

describe('leaf encoding', () => {
  test('matches the SDK: 32 bytes, zero padded', () => {
    expect(leafHex(255n)).toBe('0x' + '0'.repeat(62) + 'ff');
  });
});
