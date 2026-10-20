import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPublicClient, custom } from 'viem';
import { createEvmPoolVaultInteractor } from '@privacy-pools-v2/sdk';

import ts from 'typescript';

import { createLogCoalescer, type EventFragment } from '@/services/log-coalescer';
import { createBlockNumberMemo } from '@/services/block-number-memo';
import { createRangeWindow, sweepLogRange } from '@/services/rpc-log-chunking';
import { checkRpcRequest } from '@/services/egress-policy';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const POOL = '0x0Eb42804000000000000000000000000000097ed';

const ev = (name: string): EventFragment => ({ type: 'event', name });
const NOTE = ev('Note');
const TRANSACTED = ev('Transacted');
const DEPOSITED = ev('Deposited');
const RAGEQUIT = ev('Ragequit');

type Log = { eventName: string; blockNumber: string };
const log = (eventName: string, block: number): Log => ({ eventName, blockNumber: `0x${block.toString(16)}` });

/** A fake chain: every event of the pool emitted in blocks 100..120, one per event per block. */
function chain() {
  const calls: { names: string[]; from: bigint; to: bigint }[] = [];
  const logsFor = (names: string[], from: bigint, to: bigint): Log[] => {
    const out: Log[] = [];
    for (let b = from; b <= to; b += 1n) {
      for (const n of ['Deposited', 'Note', 'Transacted', 'Ragequit', 'LeavesInserted']) if (names.includes(n)) out.push(log(n, Number(b)));
    }
    return out;
  };
  const fetcher = (from: bigint, to: bigint) => async (events: EventFragment[]) => {
    const names = events.map((e) => e.name!);
    calls.push({ names, from, to });
    return logsFor(names, from, to);
  };
  return { calls, fetcher, logsFor };
}

function manual() {
  let clock = 0;
  const queue: (() => void)[] = [];
  return {
    now: () => clock,
    advance: (ms: number) => { clock += ms; },
    schedule: (fn: () => void) => { queue.push(fn); },
    flush: async () => {
      while (queue.length) queue.shift()!();
      await Promise.resolve();
    },
  };
}

describe('log coalescer', () => {
  test('concurrent reads of one window become one call, each caller gets only its events', async () => {
    const c = chain();
    const co = createLogCoalescer<Log>({ ttlMs: 12_000 });
    const [d, t, r] = await Promise.all([
      co.fetch(POOL, [DEPOSITED], 110n, 110n, c.fetcher(110n, 110n)),
      co.fetch(POOL, [TRANSACTED], 110n, 110n, c.fetcher(110n, 110n)),
      co.fetch(POOL, [RAGEQUIT], 110n, 110n, c.fetcher(110n, 110n)),
    ]);
    expect(c.calls.length).toBe(1);
    expect(c.calls[0].names.sort()).toEqual(['Deposited', 'Ragequit', 'Transacted']);
    expect(d).toEqual(c.logsFor(['Deposited'], 110n, 110n));
    expect(t).toEqual(c.logsFor(['Transacted'], 110n, 110n));
    expect(r).toEqual(c.logsFor(['Ragequit'], 110n, 110n));
  });

  test('a head top-up also fetches the other known events, so the next reader of that block costs nothing', async () => {
    const c = chain();
    const m = manual();
    const co = createLogCoalescer<Log>({ ttlMs: 12_000, now: m.now, schedule: m.schedule });
    // Discovery has read Note before; the index reads its three on the next block.
    const first = co.fetch(POOL, [NOTE], 109n, 109n, c.fetcher(109n, 109n));
    await m.flush();
    await first;
    const three = Promise.all([DEPOSITED, TRANSACTED, RAGEQUIT].map((e) => co.fetch(POOL, [e], 110n, 110n, c.fetcher(110n, 110n))));
    await m.flush();
    await three;
    expect(c.calls.length).toBe(2);
    expect(c.calls[1].names.sort()).toEqual(['Deposited', 'Note', 'Ragequit', 'Transacted']);
    // Discovery then asks for block 110: answered from memory.
    m.advance(3_000);
    const note = await co.fetch(POOL, [NOTE], 110n, 110n, c.fetcher(110n, 110n));
    expect(c.calls.length).toBe(2);
    expect(note).toEqual(c.logsFor(['Note'], 110n, 110n));
  });

  test('a covering result answers a narrower window, filtered to it', async () => {
    const c = chain();
    const m = manual();
    const co = createLogCoalescer<Log>({ ttlMs: 12_000, now: m.now, schedule: m.schedule });
    const wide = co.fetch(POOL, [NOTE, TRANSACTED], 105n, 112n, c.fetcher(105n, 112n));
    await m.flush();
    await wide;
    const narrow = await co.fetch(POOL, [TRANSACTED], 108n, 109n, c.fetcher(108n, 109n));
    expect(c.calls.length).toBe(1);
    expect(narrow).toEqual(c.logsFor(['Transacted'], 108n, 109n));
  });

  test('results expire after the ttl', async () => {
    const c = chain();
    const m = manual();
    const co = createLogCoalescer<Log>({ ttlMs: 12_000, now: m.now, schedule: m.schedule });
    const a = co.fetch(POOL, [NOTE], 110n, 110n, c.fetcher(110n, 110n));
    await m.flush();
    await a;
    m.advance(12_000);
    const b = co.fetch(POOL, [NOTE], 110n, 110n, c.fetcher(110n, 110n));
    await m.flush();
    await b;
    expect(c.calls.length).toBe(2);
  });

  test('a large window never widens past the events asked for together', async () => {
    const c = chain();
    const m = manual();
    const co = createLogCoalescer<Log>({ ttlMs: 12_000, now: m.now, schedule: m.schedule, smallWindowBlocks: 256n });
    const a = co.fetch(POOL, [NOTE], 100n, 100n, c.fetcher(100n, 100n));
    await m.flush();
    await a;
    const r = co.fetch(POOL, [RAGEQUIT], 0n, 9_999n, async (events) => {
      c.calls.push({ names: events.map((e) => e.name!), from: 0n, to: 9_999n });
      return [];
    });
    await m.flush();
    await r;
    expect(c.calls[1].names).toEqual(['Ragequit']);
  });

  test('different addresses are never merged', async () => {
    const c = chain();
    const co = createLogCoalescer<Log>({ ttlMs: 12_000 });
    await Promise.all([
      co.fetch(POOL, [NOTE], 110n, 110n, c.fetcher(110n, 110n)),
      co.fetch('0x1111111111111111111111111111111111111111', [NOTE], 110n, 110n, c.fetcher(110n, 110n)),
    ]);
    expect(c.calls.length).toBe(2);
  });

  test('name clashes and non-event fragments go straight through', async () => {
    const c = chain();
    const co = createLogCoalescer<Log>({ ttlMs: 12_000 });
    await Promise.all([
      co.fetch(POOL, [{ type: 'function', name: 'x' }], 110n, 110n, c.fetcher(110n, 110n)),
      co.fetch(POOL, [{ type: 'function', name: 'x' }], 110n, 110n, c.fetcher(110n, 110n)),
    ]);
    expect(c.calls.length).toBe(2);

    await co.fetch(POOL, [NOTE], 111n, 111n, c.fetcher(111n, 111n));
    const clash = { type: 'event', name: 'Note', inputs: [{ name: 'x', type: 'uint256' }] } as EventFragment;
    await co.fetch(POOL, [clash], 112n, 112n, c.fetcher(112n, 112n));
    expect(c.calls.at(-1)!.names).toEqual(['Note']);
    expect(c.calls.length).toBe(4);
  });

  test('a failure reaches every waiter and is not remembered', async () => {
    const m = manual();
    const co = createLogCoalescer<Log>({ ttlMs: 12_000, now: m.now, schedule: m.schedule });
    let calls = 0;
    const failing = async () => { calls += 1; throw new Error('limit exceeded'); };
    const a = co.fetch(POOL, [NOTE], 110n, 110n, failing);
    const b = co.fetch(POOL, [TRANSACTED], 110n, 110n, failing);
    await m.flush();
    await expect(a).rejects.toThrow('limit exceeded');
    await expect(b).rejects.toThrow('limit exceeded');
    expect(calls).toBe(1);
    const c = chain();
    const again = co.fetch(POOL, [NOTE], 110n, 110n, c.fetcher(110n, 110n));
    await m.flush();
    expect(await again).toEqual(c.logsFor(['Note'], 110n, 110n));
  });
});

describe('the merged request on the wire', () => {
  test('the four pool events of the trace are one topic0 OR-list, and the egress policy allows it', async () => {
    // The event ABIs come from the SDK's own PoolVaultInteractor, as it passes
    // them to the RPC interactor, not from a list in this file.
    const requested: unknown[] = [];
    const recorder = {
      getLogsPaginated: async (p: { events: unknown[] }) => { requested.push(...p.events); return []; },
      getLogs: async (p: { events: unknown[] }) => { requested.push(...p.events); return []; },
      getBlockNumber: async () => '0x6e',
    };
    const vault = createEvmPoolVaultInteractor({ rpcInteractor: recorder as never, contractAddress: POOL as `0x${string}` });
    // The leaf reader is private in the typings; it is what getStateLeaves runs on RPC.
    await (vault as unknown as { getStateLeavesFromEvents(): Promise<unknown> }).getStateLeavesFromEvents();
    await vault.getTransactedEvents('0x6e', '0x6e');
    await vault.getDepositedEvents('0x6e', '0x6e');
    await vault.getRagequitEvents('0x6e', '0x6e');
    expect(requested.length).toBe(4);

    const bodies: { method: string; params: unknown[] }[] = [];
    const client = createPublicClient({
      transport: custom({
        async request({ method, params }) {
          bodies.push({ method, params: params as unknown[] });
          return [];
        },
      }),
    });
    await client.getLogs({
      address: POOL as `0x${string}`,
      events: requested as never,
      fromBlock: 110n,
      toBlock: 110n,
    });
    const call = bodies.find((b) => b.method === 'eth_getLogs')!;
    const filter = call.params[0] as { topics: unknown[] };
    expect(filter.topics.length).toBe(1);
    expect(Array.isArray(filter.topics[0])).toBe(true);
    expect((filter.topics[0] as string[]).map((t) => t.slice(0, 10)).sort()).toEqual(['0x10763cc4', '0x507455b2', '0x71efc8d0', '0xed45e0df']); // Transacted, Ragequit, LeavesInserted, Deposited
    const verdict = checkRpcRequest({
      method: 'POST',
      url: 'https://rpc.example/',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: call.params }),
    });
    expect(verdict).toEqual({ allowed: true });
  });
});

describe('wiring', () => {
  const source = readFileSync(join(ROOT, 'services', 'sdk-setup.ts'), 'utf8');

  test('every RPC log window goes through the chain coalescer, after the ASP decision', () => {
    expect(source).toContain('coalescer.fetch(address, events, start, end, plain)');
    // The coalescer lives in sweep() only; the ASP fast path runs before it.
    const getLogs = source.slice(source.indexOf('  async getLogs(params: GetLogsParams)'), source.indexOf('  private sweep('));
    expect(getLogs).toContain('this.fetchFromASP(aspKind, startFrom, to)');
    expect(getLogs).not.toContain('coalescer.fetch');
  });

  test('the chain head comes from the shared per-chain memo', () => {
    expect(source).toContain('chainHeads.get(this.chainId');
    expect(source).toContain('to = await this.head();');
    expect(source).toContain('cacheTime: blockTimeMs(chainId)');
  });
});

// Runs the production getLogs + sweep + head methods of ChunkedRPCInteractor
// (compiled from source, like discovery-wiring.test.ts) against a counting
// inner interactor: the relayed-withdrawal trace, one new block.
describe('ChunkedRPCInteractor, one new block', () => {
  const setup = ts.createSourceFile('sdk-setup.ts', readFileSync(join(ROOT, 'services', 'sdk-setup.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const rpc = setup.statements.find((s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === 'ChunkedRPCInteractor')!;
  const method = (name: string) => rpc.members.find((m) => m.name?.getText(setup) === name)!.getText(setup);
  const compile = (source: string, env: Record<string, unknown>) => new Function(...Object.keys(env),
    ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText)(...Object.values(env));

  test('four per-event top-ups of the same block are one eth_getLogs, and each gets its own logs', async () => {
    const coalescer = createLogCoalescer<Log>({ ttlMs: 12_000 });
    let clock = 0;
    const heads = createBlockNumberMemo({ ttlMs: () => 12_000, now: () => clock });
    const Adapter = compile(`class ChunkedRPCInteractor {
      ${method('getBlockNumber')}
      ${method('head')}
      ${method('getLogs')}
      ${method('sweep')}
    }; return ChunkedRPCInteractor;`, {
      alignLogScanStart: (n: bigint) => n,
      LEGACY_CONFIG: false,
      detectAspKind: (p: { events: EventFragment[] }) => (p.events[0].name === 'LeavesInserted' ? 'leaves' : null),
      logCoalescerForChain: () => coalescer,
      chainHeads: heads,
      sweepLogRange,
      toHex: (n: bigint) => `0x${n.toString(16)}`,
      console: { log() {}, warn() {} },
    });
    const c = chain();
    let head = 109n;
    let blockNumberCalls = 0;
    const adapter = Object.assign(new Adapter(), {
      chainId: 1,
      deploymentBlock: 0n,
      cache: new Map(),
      rangeWindow: createRangeWindow(10_000n),
      inner: {
        getBlockNumber: async () => { blockNumberCalls += 1; return `0x${head.toString(16)}`; },
        getLogs: async (p: { events: EventFragment[]; fromBlock: bigint; toBlock: bigint }) =>
          c.fetcher(p.fromBlock, p.toBlock)(p.events),
      },
      // The ASP has not indexed the new block yet: its whole range is RPC tail.
      fetchFromASP: async (_k: string, from: bigint) => ({ logs: [], lastBlock: from - 1n }),
    });
    const read = (name: string) => adapter.getLogs({ address: POOL, events: [ev(name)], fromBlock: 100n });
    const index = () => Promise.all(['Deposited', 'Transacted', 'Ragequit'].map(read));

    // Warm every per-event cache up to block 109.
    await index();
    await read('LeavesInserted');
    const warm = c.calls.length;

    // Block 110 arrives one block time later.
    head = 110n;
    clock += 12_000;
    const [d, t, r] = await index();
    const leaves = await read('LeavesInserted');

    expect(c.calls.length - warm).toBe(1);
    const merged = c.calls.at(-1)!;
    expect([merged.from, merged.to]).toEqual([110n, 110n]);
    expect([...merged.names].sort()).toEqual(['Deposited', 'LeavesInserted', 'Ragequit', 'Transacted']);
    expect(d).toEqual(c.logsFor(['Deposited'], 100n, 110n));
    expect(t).toEqual(c.logsFor(['Transacted'], 100n, 110n));
    expect(r).toEqual(c.logsFor(['Ragequit'], 100n, 110n));
    expect(leaves).toEqual(c.logsFor(['LeavesInserted'], 100n, 110n));
    expect(blockNumberCalls).toBe(2);
  });
});
