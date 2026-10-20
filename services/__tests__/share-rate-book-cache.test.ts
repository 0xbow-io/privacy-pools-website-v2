import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { readShareRateSeries, type RateHistoryClient, type ShareRateSeries } from '../share-rate-history';
import { shareRateKey } from '../share-rates';

const loaderSource = new URL('../share-rate-feed.ts', import.meta.url);
const source = ts.createSourceFile(loaderSource.pathname, readFileSync(loaderSource, 'utf8'), ts.ScriptTarget.Latest, true);
const code = source.statements.filter((node) => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
  .map((node) => node.getText(source).replace(/^export /, '')).join('\n');

const CHAIN = 1;
const START = 1_000n;
const HEAD = 1_004n;
const E18 = 10n ** 18n;
const deployments = ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002']
  .map((ppUSDC) => ({ ppUSDC, ppUSDCDecimals: 18, underlying: '0x0000000000000000000000000000000000000003',
    underlyingSymbol: 'USDC', underlyingDecimals: 18 }));

function setup(client: RateHistoryClient, read = readShareRateSeries) {
  let now = 0;
  const env = {
    supportedChainIds: [CHAIN],
    getChainConfig: () => ({ chainType: 'evm', rpcUrls: ['https://rpc.invalid'], contracts: { fromBlock: START } }),
    getConfiguredYieldDeployments: () => deployments,
    getKnownTokenMetadata: () => undefined,
    createPublicClient: () => client,
    fallback: (transports: unknown) => transports,
    policedHttp: (url: string) => url,
    readShareRateSeries: read,
    shareRateKey,
    Date: { now: () => now },
  };
  const loader = new Function(...Object.keys(env), ts.transpileModule(`${code}\nreturn { seriesForChain, fetchShareRateBook };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText)(...Object.values(env)) as {
    seriesForChain: (chainId: number) => Promise<ShareRateSeries[]>;
    fetchShareRateBook: () => Promise<Map<string, ShareRateSeries>>;
  };
  return { ...loader, advance: () => { now += 10 * 60_000; }, setNow: (value: number) => { now = value; } };
}

function successfulClient(partial = false): RateHistoryClient {
  return {
    getBlockNumber: async () => HEAD,
    multicall: async ({ blockNumber }) => [
      { status: 'success', result: E18 },
      partial ? { status: 'failure', error: new Error('no code') } : { status: 'success', result: E18 },
      { status: 'success', result: blockNumber * 10n },
    ],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('share-rate book cache', () => {
  test('an off-grid load expires at the snapped ten-minute boundary', async () => {
    let reads = 0;
    const loader = setup(successfulClient(), (...args) => { reads++; return readShareRateSeries(...args); });
    loader.setNow(123_456);
    const first = loader.seriesForChain(CHAIN);
    await first;
    loader.setNow(599_999);
    expect(loader.seriesForChain(CHAIN)).toBe(first);
    loader.setNow(600_000);
    const next = loader.seriesForChain(CHAIN);
    expect(next).not.toBe(first);
    await next;
    expect(reads).toBe(2);
  });

  test('all multicalls failing resolves fail-soft series but the next book load reads again', async () => {
    let heads = 0;
    let multicalls = 0;
    const loader = setup({
      getBlockNumber: async () => { heads++; return HEAD; },
      multicall: async () => { multicalls++; throw new Error('RPC unavailable'); },
    });
    const first = await loader.fetchShareRateBook();
    expect(first.size).toBe(2);
    expect([...first.values()].every((s) => s.current === null && s.history.length === 0)).toBe(true);
    const firstCalls = multicalls;
    expect(firstCalls).toBeGreaterThan(0);
    const second = await loader.fetchShareRateBook();
    expect(second).toEqual(first);
    expect(heads).toBe(2);
    expect(multicalls).toBe(firstCalls * 2);
  });

  test('an empty resolved series is retried', async () => {
    let reads = 0;
    const loader = setup(successfulClient(), async () => { reads++; return []; });
    expect((await loader.fetchShareRateBook()).size).toBe(0);
    expect((await loader.fetchShareRateBook()).size).toBe(0);
    expect(reads).toBe(2);
  });

  test('a rejecting head read stays fail-soft and is retried', async () => {
    let heads = 0;
    const client = successfulClient();
    client.getBlockNumber = async () => { heads++; throw new Error('head unavailable'); };
    const loader = setup(client);
    expect((await loader.fetchShareRateBook()).size).toBe(0);
    expect((await loader.fetchShareRateBook()).size).toBe(0);
    expect(heads).toBe(2);
  });

  for (const partial of [false, true]) {
    test(`${partial ? 'partially' : 'fully'} successful current rates retain the cached promise and output`, async () => {
      let reads = 0;
      const loader = setup(successfulClient(partial), (...args) => { reads++; return readShareRateSeries(...args); });
      const pending = loader.seriesForChain(CHAIN);
      const result = await pending;
      expect(result.filter((s) => s.current != null)).toHaveLength(partial ? 1 : 2);
      expect(loader.seriesForChain(CHAIN)).toBe(pending);
      expect(await loader.seriesForChain(CHAIN)).toBe(result);
      const book = await loader.fetchShareRateBook();
      expect([...book.values()]).toEqual(result);
      expect(book.get(shareRateKey(CHAIN, result[0].ref.share))).toBe(result[0]);
      expect(reads).toBe(1);
    });
  }

  test('in-flight loads dedupe the real head and multicall reads', async () => {
    const head = deferred<bigint>();
    let heads = 0;
    let multicalls = 0;
    const client = successfulClient();
    const loader = setup({
      getBlockNumber: () => { heads++; return head.promise; },
      multicall: (args) => { multicalls++; return client.multicall(args); },
    });
    const pending = loader.seriesForChain(CHAIN);
    expect(loader.seriesForChain(CHAIN)).toBe(pending);
    const first = loader.fetchShareRateBook();
    const second = loader.fetchShareRateBook();
    expect(heads).toBe(1);
    expect(multicalls).toBe(0);
    head.resolve(HEAD);
    expect(await first).toEqual(await second);
    expect(multicalls).toBeGreaterThan(0);
    expect(heads).toBe(1);
  });

  for (const rejects of [false, true]) {
    test(`a stale ${rejects ? 'rejection' : 'empty result'} cannot evict a newer entry`, async () => {
      const stale = deferred<ShareRateSeries[]>();
      let reads = 0;
      const loader = setup(successfulClient(), (...args) => {
        reads++;
        return reads === 1 ? stale.promise : readShareRateSeries(...args);
      });
      const old = loader.seriesForChain(CHAIN);
      loader.advance();
      const fresh = loader.seriesForChain(CHAIN);
      const result = await fresh;
      expect(result.some((s) => s.current != null)).toBe(true);
      if (rejects) stale.reject(new Error('late failure'));
      else stale.resolve([]);
      expect(await old).toEqual([]);
      expect(loader.seriesForChain(CHAIN)).toBe(fresh);
      expect(reads).toBe(2);
    });
  }
});
