import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createChainLimiter, earliestScanOptions, feedHasData, snapshotActivityFingerprint, snapshotScanComplete, sweepChains } from '../chain-sweep';
import { feedData } from '../public-feed-scheduler';
import { createRangeWindow, sweepLogRange } from '../rpc-log-chunking';
import ts from 'typescript';
import { snapshotCursor } from '../asp-event-snapshot';
import { createSnapshotStore } from '../snapshot-cache';
import { alignLogScanStart } from '../log-scan-alignment';
import { OnChainNoteIndex } from '../onchain-note-index';
import { HttpASPDataProvider } from '@privacy-pools-v2/sdk';
import { assertDepositUnlock } from '../deposit-unlock-guard';

// The sweep's data gate, satisfied: every chain's held snapshot is ready.
const feedReady = (ready: (cid: number) => boolean = () => true) => ({
  waitForFeed: async (_f: unknown, key: string) => ready(Number(String(key).split(':')[1])),
  publicFeeds: {}, feedEventSnapshot: (cid: number) => `event-snapshot:${cid}`,
  discoveriesRef: { current: new WeakMap() },
  earliestScanOptions, noteManager: undefined, limitSiblingDiscoveryRef: { current: createChainLimiter() }, siblingFlightsRef: { current: new WeakMap() },
  SNAPSHOT_READY_WAIT_MS: 0, deferredPrimaryRef: { current: null as unknown },
  // The sweep records what it scanned for the grid pass; covered by snapshot-request-timing.
  heldScanFingerprint: async () => ({ held: null, fingerprint: null }), markSnapshotScanned() {},
});

const root = new URL('../../', import.meta.url);
const ast = (path: string) => ts.createSourceFile(path, readFileSync(new URL(path, root), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const compile = (source: string, env: Record<string, unknown>) => new Function(...Object.keys(env),
  ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(env));
const setup = ast('services/sdk-setup.ts');
const rpc = setup.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === 'ChunkedRPCInteractor')!;
const method = (name: string) => rpc.members.find((m) => m.name?.getText(setup) === name)!.getText(setup);

// Execute the production leaf adapter and getLogs path, not a copy of cursor math.
// The adapter reads the copy the feed grid holds (services/snapshot-source.ts)
// and must never reach the ASP itself: the SDK calls it while it prepares every
// spend proof.
const noAsp = new Proxy({}, { get() { throw new Error('the leaf path must not reach the API client'); } });
function leafAdapter(env: Record<string, unknown>) {
  const Adapter = compile(`class ChunkedRPCInteractor {
    ${method('fetchFromASP')}
    ${method('getLogs')}
  }; return ChunkedRPCInteractor;`, {
    snapshotCursor, LEGACY_CONFIG: false, alignLogScanStart: (n: bigint) => n, detectAspKind: () => 'leaves',
    resolveConfiguredEntrypoint: async () => 'pool', apiClient: noAsp,
    synthLeavesInsertedLog: (row: unknown) => row, synthKeystoreLog: (row: unknown) => row,
    console: { log() {}, warn() {} },
    ...env,
  });
  return Adapter;
}

describe('ASP leaf scan coverage', () => {
  for (const cursor of ['25978254', '25961000', '0', undefined]) test(`quiet pool with watermark ${cursor}`, async () => {
    const tails: bigint[] = [];
    let reads = 0;
    const from = 25960000n, to = 25978254n, leafBlock = 25962235n;
    const Adapter = leafAdapter({
      loadPoolLeaves: async () => {
        reads++; return { snapshotBlockNumber: cursor, leaves: [{ blockNumber: String(leafBlock) }] };
      },
    });
    const adapter = Object.assign(new Adapter(), { chainId: 1, cache: new Map(), deploymentBlock: 0n,
      sweep: async (_params: unknown, start: bigint) => { tails.push(start); return []; } });
    const params = { fromBlock: from, toBlock: to };
    expect(await adapter.getLogs(params)).toHaveLength(1);
    adapter.cache.clear(); // a second session scan reads the same held copy
    expect(await adapter.getLogs(params)).toHaveLength(1);
    const resume = cursor && cursor !== '0' ? BigInt(cursor) + 1n : from;
    // Rows above the held watermark come from the RPC tail, so the tree is
    // exact at the head however old the copy is.
    expect(tails).toEqual([resume, resume]);
    expect(reads).toBe(2);
  });
});

describe('leaf reads never fetch (the grid owns the leaves)', () => {
  test('the adapter has no path to the ASP', () => {
    const source = method('fetchFromASP');
    expect(source).toContain('loadPoolLeaves(');
    expect(source).not.toContain('apiClient');
    expect(source).not.toContain('getEventSnapshotPayload');
  });

  test('any requested range is served from the held copy, sliced, with its watermark', async () => {
    const rows = [
      { blockNumber: '25884300', leafIndex: '0' },
      { blockNumber: '25990000', leafIndex: '1' },
      { blockNumber: '26098000', leafIndex: '2' },
    ];
    const Adapter = leafAdapter({
      loadPoolLeaves: async () => ({ snapshotBlockNumber: '26098100', leaves: rows, keystoreLeaves: [] }),
    });
    const adapter = Object.assign(new Adapter(), { chainId: 1 });
    const whole = await adapter.fetchFromASP('leaves', 25880000n, 26098200n);
    expect(whole.logs).toHaveLength(3);
    expect(whole.lastBlock).toBe(26098100n);
    const middle = await adapter.fetchFromASP('leaves', 25990000n, 26000000n);
    expect(middle.logs.map((r: { leafIndex: string }) => r.leafIndex)).toEqual(['1']);
    expect(middle.lastBlock).toBe(26000000n);
  });

  test('a copy that cannot be read falls back to RPC, never to the ASP', async () => {
    for (const failure of ['not loaded yet', 'not the pool the feed grid refreshes']) {
      const Adapter = leafAdapter({ loadPoolLeaves: async () => { throw new Error(failure); } });
      const adapter = Object.assign(new Adapter(), { chainId: 1 });
      expect(await adapter.fetchFromASP('leaves', 1n, 100n)).toBeNull();
    }
  });
});

test('missing leaf sections fall back to RPC while explicit empty sections cover history', async () => {
  for (const kind of ['leaves', 'keystoreLeaves']) {
    for (const section of [undefined, null, []]) {
      const Adapter = leafAdapter({
        loadPoolLeaves: async () => ({ snapshotBlockNumber: '100', [kind]: section }),
      });
      const adapter = Object.assign(new Adapter(), { chainId: 1 });
      const result = await adapter.fetchFromASP(kind === 'leaves' ? 'leaves' : 'keystore', 1n, 100n);
      expect(result).toEqual(section ? { logs: [], lastBlock: 100n } : null);
    }
  }
});

test('old discovery completion cannot persist into a replacement session', async () => {
  const source = ast('components/sdk-provider.tsx');
  const provider = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'SdkProvider')!;
  const declaration = provider.body!.statements.find((s) => ts.isVariableStatement(s)
    && s.declarationList.declarations.some((d) => d.name.getText(source) === 'discoverNotes'))!;
  let finish!: (notes: unknown[]) => void;
  let writes = 0;
  let busy = false;
  const manager = { getNotes: () => [], exportState: () => ({ notes: [] }) };
  const committedSessionRef = { current: { noteManager: manager } };
  const sync = compile(declaration.getText(source) + '; return discoverNotes;', {
    useCallback: (fn: unknown) => fn, noteManager: manager, effectiveAddress: 'wallet-a', chainId: 1,
    poolSession: { discoverNotes: () => new Promise((resolve) => { finish = resolve; }) },
    committedSessionRef, setIsSyncing(value: boolean) { busy = value; }, log() {}, perfPhaseStart() {}, perfPhaseEnd() {},
    refreshNotes() {}, setSyncedHoldings() {}, saveStoredAccountExport() { writes++; },
    resolveNotePersistTarget() { writes++; throw new Error('stale completion reached persistence'); },
    describeRpcError: String, describeErrorFrames: () => [],
  });
  const pending = sync();
  committedSessionRef.current = { noteManager: { ...manager } };
  finish([]);
  expect(await pending).toBeNull();
  expect(writes).toBe(0);
  expect(busy).toBe(true); // Old completion must not clear the replacement's discovery state.
});

test('timestamp healing bypasses an ASP hint that already failed leaf verification', async () => {
  const source = ast('services/onchain-note-index.ts');
  const index = source.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === 'OnChainNoteIndex')!;
  const member = index.members.find((m) => m.name?.getText(source) === 'fetchBlockTimestamps')!;
  let reads = 0;
  // Replace only the lazy configuration import; the production resolver runs intact.
  const configured = compile(`return ({ ${member.getText(source).replace('private ', '').replace("await import('@/config/chains')", "({ getChainConfig: () => ({ rpcUrls: ['rpc'] }) })")} }).fetchBlockTimestamps;`, {
    createPublicClient: () => ({ getBlock: async () => { reads++; return { timestamp: 42n }; } }),
    fallback: () => null, policedHttp: () => null, BLOCK_TIMESTAMP_CONCURRENCY: 16,
    getAspBlockTimestamp: () => '0xdead', toHex: (n: bigint) => `0x${n.toString(16)}`,
    console: { log() {} },
  });
  const receiver = { params: { chainId: 1 }, blockTimestamps: new Map(), aspSourcedBlocks: new Set(),
    loadPersistedBlockTimestamps() {}, flushPersistedBlockTimestamps() {} };
  expect((await configured.call(receiver, ['0x64'])).get('0x64')).toBe('0xdead');
  expect((await configured.call(receiver, ['0x64'], true)).get('0x64')).toBe('0x2a');
  expect(reads).toBe(1);
});


test('SDK and frontend share a snapshot while the real SDK parser retains dropped-row coverage', async () => {
  const address = `0x${'11'.repeat(20)}` as `0x${string}`;
  const url = `https://asp.example/1/public/event-snapshot/payload?entrypoint=${address}`;
  let downloads = 0;
  let passthrough = 0;
  const store = createSnapshotStore({
    fetchFull: async () => {
      downloads++;
      return { chainId: '1', snapshotBlockNumber: '100', generatedAt: '2026-09-14T00:00:00Z',
        deposits: [], transacts: [{ blockNumber: '90' }], ragequits: [], leaves: [], keystoreLeaves: [] };
    },
  });
  const factory = setup.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s)
    && s.name?.text === 'createEntrypointScopedHttpClient')!;
  const wrap = compile(`${factory.getText(setup)}; return createEntrypointScopedHttpClient;`, {
    resolveConfiguredEntrypoint: async () => address,
  });
  const providerFactory = setup.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s)
    && s.name?.text === 'createASPDataProvider')!;
  const wiring = providerFactory.body!.statements.find((s) => ts.isVariableStatement(s)
    && s.declarationList.declarations.some((d) => d.name.getText(setup) === 'aspHttpClient'))!;
  const http = compile(wiring.getText(setup) + '; return aspHttpClient;', {
    LEGACY_CONFIG: false, ASP_URL: 'https://asp.example/', chainId: 1, entrypointAddress: address,
    httpClient: { get: async () => { passthrough++; return {}; } },
    createEntrypointScopedHttpClient: wrap,
    loadPoolEventSnapshot: (chainId: number, options: { entrypoint: string }) => store.read(`${chainId}:${options.entrypoint}`, { mayBootstrap: true }),
  });
  const provider = new HttpASPDataProvider({ aspUrl: 'https://asp.example', chainId: 1, entrypointAddress: address, httpClient: http });
  const [parsed, raw] = await Promise.all([provider.getEventSnapshot(), store.read(`1:${address}`, { mayBootstrap: true })]);
  expect(downloads).toBe(1);
  expect(passthrough).toBe(0);
  expect(BigInt(parsed.snapshotBlockNumber)).toBe(100n);
  expect(parsed.transacts).toEqual([]);
  expect(parsed.drops?.transacts?.dropped).toBe(1);
  expect(BigInt(parsed.drops!.transacts!.earliestDroppedBlock!)).toBe(90n);
  expect(raw.transacts).toHaveLength(1); // parsing must not mutate the shared payload
  await provider.getEventSnapshot();
  expect(downloads).toBe(1);
  // Filtered requests and a different pool cannot be answered by this snapshot.
  await http.get(`${url}&include=leaves`);
  await http.get(url.replace(address, `0x${'22'.repeat(20)}`));
  expect(passthrough).toBe(2);
});

// The real privacy grid and production cache sit between the index and the RPC.
function logAdapter(events: Array<{ blockNumber: string; outputCommitment?: string; outputCommitments?: string[]; nullifierHashes?: string[] }>) {
  const reads: bigint[][] = [];
  const Adapter = compile(`class Adapter { ${method('getLogs')} }; return Adapter;`, {
    alignLogScanStart, LEGACY_CONFIG: false, detectAspKind: () => null,
  });
  const adapter = Object.assign(new Adapter(), { cache: new Map(), deploymentBlock: 0n,
    inner: { getBlockNumber: async () => 21000n },
    // The wrapper reads the head through its shared per-chain memo.
    head: async () => 21000n,
    sweep: async (_params: unknown, from: bigint, to: bigint) => {
      reads.push([from, to]);
      return events.filter(e => BigInt(e.blockNumber) >= from && BigInt(e.blockNumber) <= to);
    },
  });
  return { adapter, reads };
}

test('backward scans fetch missing history; covered scans and extensions retain it', async () => {
  const event = { blockNumber: '10000', outputCommitment: '0xabc' };
  const { adapter, reads } = logAdapter([event]);
  expect(await adapter.getLogs({ fromBlock: 20000n, toBlock: 21000n })).toEqual([]);
  expect(await adapter.getLogs({ fromBlock: 10001n, toBlock: 10001n })).toEqual([event]);
  expect(await adapter.getLogs({ fromBlock: 10002n, toBlock: 22000n })).toEqual([event]);
  expect(await adapter.getLogs({ fromBlock: 10001n, toBlock: 10001n })).toEqual([event]);
  expect(reads).toEqual([[20000n, 21000n], [10000n, 10001n], [10002n, 22000n]]);
});

for (const kind of ['deposit', 'transact']) for (const claimed of [10000, 10001]) {
  test(`${kind} timestamp healing requires its own block despite widened RPC results (${claimed})`, async () => {
    const commitment = '0xabc';
    const { adapter, reads } = logAdapter([kind === 'deposit'
      ? { blockNumber: '10000', outputCommitment: commitment }
      : { blockNumber: '10000', outputCommitments: [commitment], nullifierHashes: [] }]);
    const read = (fromBlock?: string, toBlock?: string) => adapter.getLogs({ fromBlock, toBlock });
    const index = new OnChainNoteIndex({ chainId: 1, hashService: { hash: () => '0x1' } as never,
      poolVaultInteractor: { getStateLeaves: async () => [], getRagequitEvents: async () => [],
        getDepositedEvents: kind === 'deposit' ? read : async () => [],
        getTransactedEvents: kind === 'transact' ? read : async () => [], } as never,
      loadEventSnapshot: async () => ({ snapshotBlockNumber: '21000',
        deposits: [{ outputCommitment: commitment, blockNumber: String(claimed), blockTimestamp: '1970-01-01T00:00:01Z' }],
        // Proves the advertised coverage, so the tail stays at 21000-300 and the
        // creation block is below it — which is what makes this a HEALING test.
        // It carries no commitments or nullifiers, so it merges nothing.
        transacts: [{ outputCommitments: [], nullifierHashes: [], blockNumber: '21000', blockTimestamp: '1970-01-01T00:00:02Z' }],
        ragequits: [] }),
    });
    (index as unknown as { fetchBlockTimestamps: unknown }).fetchBlockTimestamps = async (blocks: string[]) =>
      new Map(blocks.map(b => [b, `0x${BigInt(b).toString(16)}`]));
    await index.refresh();
    expect(index.hasCommitment(commitment)).toBe(true);
    expect(index.commitmentTimestamp(commitment)).toBe(claimed === 10000 ? '0x2710' : null);
    expect(reads).toContainEqual([10000n, BigInt(claimed)]); // network start stays on the privacy grid
  });
}

for (const pause of ['primary', 'build', 'discovery', 'export', 'none']) {
  test(`secondary discovery preserves newer same-wallet notes across replacement during ${pause}`, async () => {
    const source = ast('components/sdk-provider.tsx');
    const provider = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'SdkProvider')!;
    const names = ['siblingWorld', 'siblingWorldUnchanged', 'exportAccount', 'discoverSiblingChain', 'syncAllChains'];
    const code = names.map(name => provider.body!.statements.find(s => ts.isVariableStatement(s)
      && s.declarationList.declarations.some(d => d.name.getText(source) === name))!.getText(source)).join('\n');
    const committedSessionRef = { current: { address: 'wallet-a' } };
    const batchSessionParamsRef = { current: {} }, deriveEpochRef = { current: 1 };
    let saved = { notes: ['old-note'] };
    let busy = false;
    let bumps = 0;
    const logs: string[] = [];
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    const wait = (stage: string) => stage === pause ? new Promise<void>(resolve => { release = resolve; reached(); }) : Promise.resolve();
    const run = compile(`${code}; return syncAllChains;`, {
      useCallback: (fn: unknown) => fn, sweepChains, allChainsFlightsRef: { current: new WeakMap() }, ...feedReady(), setSyncChainsLeft: () => {}, committedSessionRef, batchSessionParamsRef, deriveEpochRef,
      poolSession: null, sessionTarget: null, effectiveAddress: 'wallet-a', chainId: 1,
      supportedChainIds: [1, 10], getChainConfig: () => ({ chainType: 'evm' }),
      queryableEvmChainIds: () => [1, 10],
      syncFromSnapshot: async () => { await wait('primary'); return {}; },
      buildSessionForChain: async () => { await wait('build'); return {
        discoverNotes: async () => { await wait('discovery'); return []; },
        exportAccount: async () => { await wait('export'); return { notes: ['old-note', 'discovered-note'] }; },
      }; },
      saveStoredAccountExport: (data: typeof saved) => { saved = data; },
      liveIdentityRef: { current: { address: 'wallet-a' } }, wipedAccountKeys: new Set(),
      wipedAccountKey: () => '', withHoldingsKey: () => [], setSyncedHoldings() {},
      setIsSyncingAll(value: boolean) { busy = value; }, refreshNotes() {}, describeRpcError: String,
      recordDiscoveredSpendTimes: async () => {}, bumpPaymentRequestRevision() { bumps++; },
      log(level: string, _scope: string, message: string) { logs.push(`${level}:${message}`); },
    });
    const pending = run();
    if (pause !== 'none') {
      // Surface an early rejection instead of starving the timeout in a microtask loop.
      await Promise.race([paused, pending.then(() => { throw new Error(`Discovery never reached ${pause}`); })]);
      committedSessionRef.current = { address: 'wallet-a' }; // same address, replacement session
      saved = { notes: ['old-note', 'new-note'] };
      release();
    }
    await pending;
    expect(saved.notes).toEqual(['old-note', pause === 'none' ? 'discovered-note' : 'new-note']);
    expect(busy).toBe(pause !== 'none');
    if (pause === 'none') {
      // The sibling step ran to completion (no swallowed ReferenceError) and told
      // the Payment Requests card to reload, as the active-chain path does.
      expect(logs).toContain('info:Cross-chain discovery complete');
      expect(logs.some((l) => l.startsWith('warn:'))).toBe(false);
      expect(bumps).toBe(1);
    }
  });
}

test('spend preflight joins background discovery while forced rescans retain their range', async () => {
  const source = ast('components/sdk-provider.tsx');
  const provider = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'SdkProvider')!;
  const declaration = provider.body!.statements.find(s => ts.isVariableStatement(s)
    && s.declarationList.declarations.some(d => d.name.getText(source) === 'syncFromSnapshot'))!;
  const manager = {};
  const committedSessionRef = { current: { noteManager: manager } };
  const ranges: unknown[] = [];
  let finish!: () => void;
  const sync = compile(declaration.getText(source) + '; return syncFromSnapshot;', {
    useCallback: (fn: unknown) => fn, noteManager: manager, committedSessionRef,
    discoveriesRef: { current: new WeakMap() },
    discoverNotes: (opts: unknown) => { ranges.push(opts); return new Promise<void>(resolve => { finish = resolve; }); },
  });
  const background = sync();
  const spend = sync();
  const forced = sync({ fromBlock: '0x1' });
  await Promise.resolve();
  expect(ranges).toEqual([undefined]);
  finish();
  await Promise.all([background, spend]);
  await Promise.resolve();
  expect(ranges).toEqual([undefined, { fromBlock: '0x1' }]);
  finish();
  await forced;
  committedSessionRef.current = { noteManager: {} };
  expect(await sync()).toBeNull();
  expect(ranges).toHaveLength(2);
});

for (const scenario of [
  { primary: 1, queryable: [1, 10], expected: [1, 10] },
  { primary: 1, queryable: [10], expected: [10] },
  { primary: 1, queryable: [1], expected: [1] },
  { primary: 1, queryable: [], expected: [] },
  { primary: 999, queryable: [1, 10], expected: [999, 1, 10] },
]) test(`chain selection preserves primary ${scenario.primary} with EVM set ${scenario.queryable}`, async () => {
  const source = ast('components/sdk-provider.tsx');
  const provider = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'SdkProvider')!;
  const declaration = provider.body!.statements.find(s => ts.isVariableStatement(s)
    && s.declarationList.declarations.some(d => d.name.getText(source) === 'syncAllChains'))!;
  const scanned: number[] = [];
  let busy = false;
  const helper = provider.body!.statements.find(s => ts.isVariableStatement(s)
    && s.declarationList.declarations.some(d => d.name.getText(source) === 'discoverSiblingChain'))!;
  const run = compile(`${helper.getText(source)}\n${declaration.getText(source)}; return syncAllChains;`, {
    useCallback: (fn: unknown) => fn, sweepChains, allChainsFlightsRef: { current: new WeakMap() }, ...feedReady(), setSyncChainsLeft: () => {}, siblingWorld: () => ({ managers: {} }), siblingWorldUnchanged: () => true,
    setIsSyncingAll: (value: boolean) => { busy = value; }, effectiveAddress: 'wallet', chainId: scenario.primary,
    queryableEvmChainIds: () => scenario.queryable, supportedChainIds: [1, 10, 999],
    getChainConfig: (id: number) => ({ chainType: id === 999 ? 'sui' : 'evm' }),
    syncFromSnapshot: async () => { scanned.push(scenario.primary); return { primary: true }; },
    buildSessionForChain: async (id: number) => ({ discoverNotes: async () => { scanned.push(id); return []; } }),
    exportAccount: async () => true, liveIdentityRef: { current: { address: 'wallet' } }, wipedAccountKeys: new Set(),
    wipedAccountKey: () => '', setSyncedHoldings() {}, withHoldingsKey: () => [], log() {}, describeRpcError: String, refreshNotes() {},
    recordDiscoveredSpendTimes: async () => {}, bumpPaymentRequestRevision() {},
  });
  const result = await run();
  expect(scanned).toEqual(scenario.expected);
  expect(result).toEqual(scenario.expected.includes(scenario.primary) ? { primary: true } : null);
  expect(busy).toBe(false);
});


// The "chains left" marker and the one-sweep-per-session rule, run against the
// production syncAllChains rather than a restatement of it.
describe('syncAllChains countdown', () => {
  const load = (env: Record<string, unknown>) => {
    const source = ast('components/sdk-provider.tsx');
    const provider = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'SdkProvider')!;
    const decl = (name: string) => provider.body!.statements.find(s => ts.isVariableStatement(s)
      && s.declarationList.declarations.some(d => d.name.getText(source) === name))!.getText(source);
    return compile(`${decl('discoverSiblingChain')}\n${decl('syncAllChains')}; return syncAllChains;`, env) as
      (opts?: { fromBlock?: string }) => Promise<unknown>;
  };
  const harness = (gate?: Promise<void>, ready?: (cid: number) => boolean) => {
    const gateEnv = feedReady(ready);
    let left = 0;
    const seen: number[] = [];
    const scans: number[] = [];
    const managers = {};
    const run = load({
      useCallback: (fn: unknown) => fn, sweepChains, allChainsFlightsRef: { current: new WeakMap() }, ...gateEnv,
      setSyncChainsLeft: (v: number | ((n: number) => number)) => { left = typeof v === 'function' ? v(left) : v; seen.push(left); },
      siblingWorld: () => ({ managers }), siblingWorldUnchanged: () => true, setIsSyncingAll() {},
      effectiveAddress: 'wallet', chainId: 1, queryableEvmChainIds: () => [1, 10, 8453, 4663],
      supportedChainIds: [1, 10, 8453, 4663], getChainConfig: () => ({ chainType: 'evm' }),
      syncFromSnapshot: async () => { scans.push(1); await gate; return {}; },
      buildSessionForChain: async (id: number) => ({ discoverNotes: async () => {
        scans.push(id); if (id === 8453) throw new Error('rpc down'); return []; } }),
      exportAccount: async () => ({ notes: [] }), liveIdentityRef: { current: { address: 'wallet' } }, wipedAccountKeys: new Set(),
      wipedAccountKey: () => '', setSyncedHoldings() {}, withHoldingsKey: () => [], log() {}, describeRpcError: String,
      refreshNotes() {}, recordDiscoveredSpendTimes: async () => {}, bumpPaymentRequestRevision() {},
    });
    return { run, seen, scans, left: () => left, deferred: () => gateEnv.deferredPrimaryRef.current };
  };

  test('starts at every chain, counts each one down (failed included), ends at 0', async () => {
    const h = harness();
    await h.run();
    expect(h.seen[0]).toBe(4);
    expect(h.seen.slice(0, 5)).toEqual([4, 3, 2, 1, 0]);
    expect(h.left()).toBe(0);
  });

  test('a second call while a sweep runs joins it instead of scanning again', async () => {
    let open!: () => void;
    const h = harness(new Promise<void>((r) => { open = r; }));
    const a = h.run();
    const b = h.run();
    open();
    await Promise.all([a, b]);
    expect(h.scans.sort((x, y) => x - y)).toEqual([1, 10, 4663, 8453]);
    expect(h.seen.filter((n) => n === 4)).toHaveLength(1);
  });
});

describe('discovery waits for the held snapshot', () => {
  const load = (env: Record<string, unknown>) => {
    const source = ast('components/sdk-provider.tsx');
    const provider = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'SdkProvider')!;
    const decl = (name: string) => provider.body!.statements.find(s => ts.isVariableStatement(s)
      && s.declarationList.declarations.some(d => d.name.getText(source) === name))!.getText(source);
    return compile(`${decl('discoverSiblingChain')}\n${decl('syncAllChains')}; return syncAllChains;`, env) as
      (opts?: { fromBlock?: string }) => Promise<unknown>;
  };

  test('a chain without its snapshot is deferred, never walked from the deployment block', async () => {
    const scans: number[] = [];
    const counts: number[] = [];
    let left = 0;
    const gate = feedReady((cid) => cid !== 4114 && cid !== 1);
    const managers = {};
    const run = load({
      useCallback: (fn: unknown) => fn, sweepChains, allChainsFlightsRef: { current: new WeakMap() }, ...gate,
      setSyncChainsLeft: (v: number | ((n: number) => number)) => { left = typeof v === 'function' ? v(left) : v; counts.push(left); },
      siblingWorld: () => ({ managers }), siblingWorldUnchanged: () => true, setIsSyncingAll() {},
      effectiveAddress: 'wallet', chainId: 1, queryableEvmChainIds: () => [1, 4114, 10],
      supportedChainIds: [1, 4114, 10], getChainConfig: () => ({ chainType: 'evm' }),
      syncFromSnapshot: async () => { scans.push(1); return {}; },
      buildSessionForChain: async (id: number) => ({ discoverNotes: async () => { scans.push(id); return []; } }),
      exportAccount: async () => ({ notes: [] }), liveIdentityRef: { current: { address: 'wallet' } }, wipedAccountKeys: new Set(),
      wipedAccountKey: () => '', setSyncedHoldings() {}, withHoldingsKey: () => [], log() {}, describeRpcError: String,
      refreshNotes() {}, recordDiscoveredSpendTimes: async () => {}, bumpPaymentRequestRevision() {},
    });
    const res = await run({ fromBlock: '0x18af644' });
    expect(res).toBeNull();
    // Only the chain whose snapshot is held was scanned.
    expect(scans).toEqual([10]);
    // The active chain's deep pass waits for the grid, range kept, same session.
    expect(gate.deferredPrimaryRef.current).toEqual({ managers, opts: { fromBlock: '0x18af644' } });
    // Deferred chains still count down, so the marker never hangs.
    expect(left).toBe(0);
    expect(counts[0]).toBe(3);
  });
});

// Execute the session callbacks with controlled awaits, including the effect
// itself. These regressions are invisible to string-only privacy ratchets.
const providerSource = ast('components/sdk-provider.tsx');
const providerBody = providerSource.statements.find((s): s is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(s) && s.name?.text === 'SdkProvider')!.body!;
const providerDecl = (name: string) => providerBody.statements.find(s => ts.isVariableStatement(s)
  && s.declarationList.declarations.some(d => d.name.getText(providerSource) === name))!.getText(providerSource);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function sessionHarness() {
  const manager = { getSyncCursor: () => '0x100' };
  const owner = { noteManager: manager, keystoreManager: {}, address: 'wallet-a' };
  const world = { managers: owner, params: {}, epoch: 1 };
  let currentWorld = world;
  const scans: number[] = [];
  const ranges: unknown[] = [];
  const counts: number[] = [];
  let count = 0;
  let busy = false;
  const gate = feedReady();
  const env = {
    ...gate, useCallback: (fn: unknown) => fn, sweepChains, noteManager: manager,
    siblingWorld: () => currentWorld, siblingWorldUnchanged: (w: unknown) => w === currentWorld,
    allChainsFlightsRef: { current: new WeakMap() },
    setSyncChainsLeft: (v: number | ((n: number) => number)) => {
      count = typeof v === 'function' ? v(count) : v; counts.push(count);
    },
    setIsSyncingAll: (v: boolean) => { busy = v; }, effectiveAddress: 'wallet-a', chainId: 1,
    queryableEvmChainIds: () => [1, 10], supportedChainIds: [1, 10],
    getChainConfig: () => ({ chainType: 'evm' }),
    syncFromSnapshot: async (opts?: unknown) => { scans.push(1); ranges.push(opts); return {}; },
    buildSessionForChain: async (cid: number, opts?: { discoveryOnly?: boolean }) => {
      expect(opts?.discoveryOnly).toBe(true);
      return { discoverNotes: async () => { scans.push(cid); return []; } };
    },
    exportAccount: async () => ({ notes: [] }), liveIdentityRef: { current: { address: 'wallet-a' } },
    wipedAccountKeys: new Set(), wipedAccountKey: () => '', setSyncedHoldings() {}, withHoldingsKey: () => [],
    log() {}, describeRpcError: String, refreshNotes() {}, recordDiscoveredSpendTimes: async () => {},
    bumpPaymentRequestRevision() {},
  };
  const load = () => compile(`${providerDecl('discoverSiblingChain')}\n${providerDecl('syncAllChains')};
    return { syncAllChains, discoverSiblingChain };`, env);
  return { env, load, world, owner, scans, ranges, counts, busy: () => busy,
    replace: () => { currentWorld = { ...world, managers: { ...owner, noteManager: { ...manager } } }; } };
}

test('a forced sweep queued on an old session never adopts replacement managers or countdown', async () => {
  const h = sessionHarness();
  let finish!: () => void;
  h.env.syncFromSnapshot = async () => { h.scans.push(1); await new Promise<void>(r => { finish = r; }); return {}; };
  const { syncAllChains } = h.load();
  const initial = syncAllChains();
  const forced = syncAllChains({ fromBlock: '0x1' });
  await tick();
  h.replace();
  finish();
  expect(await initial).toBeNull();
  expect(await forced).toBeNull();
  expect(h.scans).toEqual([1]);
  expect(h.counts).toEqual([2]); // Neither old caller clears the new session's UI.
});

test('a stale callback cannot join a new account sweep or return its result', async () => {
  const h = sessionHarness();
  const { syncAllChains } = h.load();
  h.replace();
  expect(await syncAllChains()).toBeNull();
  expect(h.scans).toEqual([]);
});

test('an identity switch during snapshot wait cannot run primary discovery or overwrite a deferral', async () => {
  const h = sessionHarness();
  let finish!: (ready: boolean) => void;
  h.env.waitForFeed = () => new Promise<boolean>(r => { finish = r; });
  const { syncAllChains } = h.load();
  const pending = syncAllChains({ fromBlock: '0x1' });
  h.replace();
  const newDeferral = { managers: {}, opts: { fromBlock: '0x9' } };
  h.env.deferredPrimaryRef.current = newDeferral;
  finish(false);
  expect(await pending).toBeNull();
  expect(h.env.deferredPrimaryRef.current).toBe(newDeferral);
  expect(h.scans).toEqual([]);
});

test('a manual sweep and a grid sibling pass share one manager and export', async () => {
  const h = sessionHarness();
  let finish!: () => void;
  let builds = 0;
  let exports = 0;
  h.env.buildSessionForChain = async () => {
    builds++;
    return { discoverNotes: async () => { await new Promise<void>(r => { finish = r; }); return []; } };
  };
  h.env.exportAccount = async () => { exports++; return { notes: [] }; };
  const { syncAllChains, discoverSiblingChain } = h.load();
  const background = discoverSiblingChain(10, h.world, h.owner.keystoreManager);
  await tick();
  const foreground = syncAllChains();
  await tick();
  expect(builds).toBe(1);
  finish();
  expect(await background).toBe('synced');
  await foreground;
  expect(exports).toBe(1);
  expect(h.busy()).toBe(false);
  expect(h.counts.at(-1)).toBe(0);
});

test('incremental retries retain a deferred full range and clear it only after success', async () => {
  const h = sessionHarness();
  let ready = false;
  h.env.waitForFeed = async () => ready;
  const { syncAllChains } = h.load();
  await syncAllChains({ fromBlock: '0x1' });
  await syncAllChains();
  await syncAllChains({ fromBlock: '0x100' });
  expect(h.env.deferredPrimaryRef.current).toEqual({ managers: h.owner, opts: { fromBlock: '0x1' } });
  ready = true;
  await syncAllChains();
  expect(h.ranges).toEqual([{ fromBlock: '0x1' }]);
  expect(h.env.deferredPrimaryRef.current).toBeNull();
});

const backgroundEffect = providerBody.statements.find(s => ts.isExpressionStatement(s)
  && s.getText(providerSource).includes('const onFeed = (cid: number) =>'))!.getText(providerSource)
  .replace("await import('@/services/snapshot-source')", '({ loadPoolEventSnapshot: loadHeldSnapshot })');
function gridHarness() {
  const h = sessionHarness();
  const session = {};
  const listeners = new Map<string, () => void>();
  let state: { status: string; data?: unknown } = { status: 'ready', data: {
    notes: [], deposits: [], transacts: [], ragequits: [], snapshotBlockNumber: '100',
  } };
  let cleanup!: () => void;
  const calls: number[] = [];
  const env = {
    ...h.env, poolSession: session, useEffect: (fn: () => () => void) => { cleanup = fn(); },
    autoDiscoveredSessionsRef: { current: new WeakSet([session]) },
    backgroundSnapshotsRef: { current: new WeakMap() }, feedHasData, snapshotActivityFingerprint, snapshotScanComplete, feedData,
    loadStoredAccountExport: () => ({ syncCursor: '0x100' }),
    isSupportedEvmChainId: () => true,
    feedAssociationSet: (cid: number) => `association-set:${cid}`,
    feedLabelDecisions: (cid: number) => `label-decisions:${cid}`,
    loadHeldSnapshot: async (_cid: number) => state.data,
    publicFeeds: { read: (key: string) => key.startsWith('event-snapshot:')
      ? { ...state, data: (state.data as { snapshotBlockNumber?: string })?.snapshotBlockNumber }
      : { status: 'ready', data: 'root' }, subscribe: (key: string, fn: () => void) => { listeners.set(key, fn); return () => listeners.delete(key); } },
    discoverSiblingChain: async (cid: number) => { calls.push(cid); return 'synced'; },
  };
  const mount = () => compile(backgroundEffect, env);
  return { ...h, env, calls, mount, cleanup: () => cleanup(), set: (s: typeof state) => { state = s; },
    emit: (cid: number) => listeners.get(`event-snapshot:${cid}`)?.() };
}

test('deferred discovery resumes on a failed grid refresh carrying the held snapshot', async () => {
  const h = gridHarness();
  h.env.deferredPrimaryRef.current = { managers: h.owner, opts: { fromBlock: '0x1' } };
  h.set({ status: 'error', data: { notes: [], deposits: [], transacts: [], ragequits: [], snapshotBlockNumber: '100' } });
  h.mount();
  h.emit(1);
  h.emit(10);
  await tick();
  expect(h.ranges).toEqual([{ fromBlock: '0x1', quiet: true }]);
  expect(h.calls).toEqual([10]);
  expect(h.env.deferredPrimaryRef.current).toBeNull();
  h.emit(1);
  h.emit(10);
  await tick();
  expect(h.calls).toEqual([10]);
  expect(h.ranges).toHaveLength(1);
});

test('effect remounts keep successful fingerprints and stale completions cannot mark a new pass seen', async () => {
  const h = gridHarness();
  h.mount();
  h.emit(10);
  await tick();
  h.cleanup();
  h.mount();
  h.emit(10);
  await tick();
  expect(h.calls).toEqual([10]);
  let finish!: (value: string) => void;
  h.set({ status: 'ready', data: { notes: [{ blockNumber: '1' }], deposits: [], transacts: [], ragequits: [], snapshotBlockNumber: '100' } });
  h.env.discoverSiblingChain = () => new Promise<string>(r => { finish = r; });
  h.cleanup();
  h.mount();
  h.emit(10);
  await tick();
  h.cleanup();
  finish('synced');
  await tick();
  h.env.discoverSiblingChain = async cid => { h.calls.push(cid); return 'synced'; };
  h.mount();
  h.emit(10);
  await tick();
  expect(h.calls).toEqual([10, 10]);
});

test('RPC cache extensions and ASP tails align the wire start and discard overlap exactly once', async () => {
  const calls: [bigint, bigint][] = [];
  const Adapter = compile(`class Adapter { ${method('sweep')} }; return Adapter;`, {
    alignLogScanStart, sweepLogRange, logCoalescerForChain: () => null,
  });
  const adapter = Object.assign(new Adapter(), { chainId: 1, deploymentBlock: 0n, rangeWindow: createRangeWindow(),
    inner: { getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      calls.push([fromBlock, toBlock]);
      return [10000n, 10100n, 10200n].filter(b => b >= fromBlock && b <= toBlock).map(blockNumber => ({ blockNumber }));
    } },
  });
  expect(await adapter.sweep({}, 10100n, 10200n)).toEqual([{ blockNumber: 10100n }, { blockNumber: 10200n }]);
  expect(calls).toEqual([[10000n, 10200n]]);
  expect(await adapter.sweep({}, 10201n, 10200n)).toEqual([]);
  expect(calls).toHaveLength(1);
});

test('the discovery session builder never requests address-keyed keystore status', async () => {
  const owner = '0x1111111111111111111111111111111111111111';
  const managers = { address: owner, keystoreManager: {} };
  let statusReads = 0;
  let identityStatus: 'incompatible' | 'unknown' = 'incompatible';
  const build = compile(`${providerDecl('buildSessionForChain')}; return buildSessionForChain;`, {
    useCallback: (fn: unknown) => fn, effectiveAddress: owner, log() {},
    siblingWorld: () => ({ managers }), siblingWorldUnchanged: () => true,
    getChainConfig: () => ({ contracts: { fromBlock: 1n, poolAddress: 'pool', keystoreAddress: 'keys' } }),
    apiClient: { getEntrypoints: async () => ({}) },
    resolveEntrypointChainConfig: () => ({ entrypoint: 'entrypoint' }), isAddress: () => true,
    getSdkSetup: async () => ({ createNoteManager: () => ({}), createCircuitArtifacts: () => ({}) }),
    resolveKeystoreIdentityStatus: async () => { statusReads++; return identityStatus; },
    assertDepositUnlock,
    getPoolSessionService: async () => ({ createPoolSession: async () => ({}) }),
    loadStoredAccountExport: () => null, CIRCUIT_ARTIFACTS_BASE_URL: '',
  });
  expect(await build(10, { discoveryOnly: true })).toEqual({});
  expect(statusReads).toBe(0);
  // Deposit sessions still refuse an incompatible registration.
  await expect(build(10)).rejects.toThrow('different unlock');
  expect(statusReads).toBe(1);
  identityStatus = 'unknown';
  await expect(build(10)).rejects.toThrow('Could not verify');
  expect(statusReads).toBe(2);
});

test('unchanged pool rows retry on the grid while discovery holds its cursor, then stop', async () => {
  const h = gridHarness();
  let cursor = '0x1';
  h.env.noteManager.getSyncCursor = () => cursor;
  h.env.loadStoredAccountExport = () => ({ syncCursor: cursor });
  h.mount();
  for (let attempt = 0; attempt < 2; attempt++) {
    h.emit(1); h.emit(10);
    await tick();
  }
  expect(h.ranges).toHaveLength(2);
  expect(h.calls).toEqual([10, 10]);
  cursor = '0x100';
  h.emit(1); h.emit(10);
  await tick();
  h.emit(1); h.emit(10);
  await tick();
  expect(h.ranges).toHaveLength(3);
  expect(h.calls).toEqual([10, 10, 10]);
});

test('cleanup during the snapshot read cannot start discovery for a later session', async () => {
  const h = gridHarness();
  let finish!: (snapshot: unknown) => void;
  h.env.loadHeldSnapshot = () => new Promise<unknown>(r => { finish = r; });
  h.mount();
  h.emit(10);
  await tick();
  h.cleanup();
  h.replace();
  finish({ notes: [], deposits: [], transacts: [], ragequits: [], snapshotBlockNumber: '100' });
  await tick();
  expect(h.calls).toEqual([]);
});


test('an older in-flight discovery cannot mark a newer grid snapshot as scanned', async () => {
  const h = gridHarness();
  h.env.discoveriesRef.current.set(h.env.noteManager, Promise.resolve({}));
  h.env.siblingFlightsRef.current.set(h.owner, new Map([[10, Promise.resolve('synced')]]));
  h.mount();
  h.emit(1); h.emit(10);
  await tick();
  expect(h.scans).toEqual([]);
  expect(h.calls).toEqual([]);
  h.env.discoveriesRef.current.delete(h.env.noteManager);
  h.env.siblingFlightsRef.current.delete(h.owner);
  h.emit(1); h.emit(10);
  await tick();
  expect(h.scans).toEqual([1]);
  expect(h.calls).toEqual([10]);
});
