import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { feedData, PublicFeedScheduler, type FeedState } from '../public-feed-scheduler';
import { readShareRateSeries, type RateHistoryClient, type ShareRateSeries } from '../share-rate-history';
import { shareRateKey, type ShareDeploymentRef, type ShareRate } from '../share-rates';

const root = new URL('../../', import.meta.url);
const source = (path: string) => ts.createSourceFile(path, readFileSync(new URL(path, root), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function evaluate<T>(path: string, result: string, env: Record<string, unknown>): T {
  const file = source(path);
  const code = file.statements.filter((node) => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
    .map((node) => node.getText(file).replace(/^export /, '')).join('\n');
  return new Function(...Object.keys(env), ts.transpileModule(`${code}\nreturn ${result};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText)(...Object.values(env)) as T;
}

async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function fakeClock() {
  let now = 123_456;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id: unknown) => { timers.delete(id as number); },
    async advanceTo(target: number) {
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        timers.delete(id);
        now = timer.at;
        timer.fn();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

type Book = Map<string, ShareRateSeries>;
type FeedModule = {
  FEED_SHARE_RATE_BOOK: string;
  FEED_SHARE_RATES: string;
  SHARE_RATE_INTERVAL_MS: number;
  SHARE_DEPLOYMENTS: ShareDeploymentRef[];
  fetchShareRateBook: () => Promise<Book>;
  fetchShareRates: () => Promise<Record<string, ShareRate>>;
};

function setup({ empty = false, headGate }: { empty?: boolean; headGate?: Promise<void> } = {}) {
  const clock = fakeClock();
  const scheduler = new PublicFeedScheduler(clock);
  let failHistory = false;
  const heads: { chain: number; at: number }[] = [];
  const multicalls: { chain: number; at: number; block: bigint }[] = [];
  const live: { chain: number; share: string; at: number }[] = [];
  const deployments = (chain: number) => (chain === 1 ? [1, 2] : [3]).map((n) => ({
    ppUSDC: `0x${String(n).padStart(40, '0')}`, ppUSDCDecimals: 18,
    underlying: `0x${'4'.repeat(40)}`, underlyingSymbol: 'USDC', underlyingDecimals: 18,
  }));
  const rate = () => 10n ** 18n + BigInt(clock.now());
  const service = evaluate<FeedModule>('services/share-rate-feed.ts',
    '{ FEED_SHARE_RATE_BOOK, FEED_SHARE_RATES, SHARE_RATE_INTERVAL_MS, SHARE_DEPLOYMENTS, fetchShareRateBook, fetchShareRates }', {
      supportedChainIds: empty ? [] : [1, 10, 999],
      getChainConfig: (chain: number) => ({ chainType: chain === 999 ? 'sui' : 'evm',
        rpcUrls: [`https://rpc-${chain}.invalid`], contracts: { fromBlock: 1_000n } }),
      getConfiguredYieldDeployments: deployments,
      getKnownTokenMetadata: () => undefined,
      policedHttp: (url: string, options: { timeout: number }) => {
        expect(options.timeout).toBe(5_000);
        return Number(new URL(url).hostname.split('-')[1].split('.')[0]);
      },
      fallback: (chains: number[], options: { retryCount: number }) => {
        expect(options.retryCount).toBe(0);
        return chains[0];
      },
      createPublicClient: ({ transport: chain }: { transport: number }): RateHistoryClient => ({
        getBlockNumber: async () => {
          heads.push({ chain, at: clock.now() });
          if (headGate) await headGate;
          return 1_004n;
        },
        multicall: async ({ blockNumber, contracts }) => {
          multicalls.push({ chain, at: clock.now(), block: blockNumber });
          if (failHistory) throw new Error('archive and current unavailable');
          return contracts.map((_, i) => ({ status: 'success' as const,
            result: i === contracts.length - 1 ? blockNumber * 10n : rate() }));
        },
      }),
      fetchAssetsPerShare: async (_client: unknown, ref: ShareDeploymentRef) => {
        live.push({ chain: ref.chainId, share: ref.share, at: clock.now() });
        return rate();
      },
      readShareRateSeries, shareRateKey, Date: { now: clock.now },
    });
  scheduler.register({ key: service.FEED_SHARE_RATE_BOOK, intervalMs: service.SHARE_RATE_INTERVAL_MS, fetch: service.fetchShareRateBook });
  scheduler.register({ key: service.FEED_SHARE_RATES, intervalMs: service.SHARE_RATE_INTERVAL_MS, fetch: service.fetchShareRates });
  let previous: { deps: unknown[]; callback: unknown } | undefined;
  const hooks = evaluate<{
    useShareRateBook: () => Book | null;
    useShareRates: () => { rateFor: (chain: number, share: string | undefined) => ShareRate | undefined; loading: boolean };
  }>('hooks/use-share-rates.ts', '{ useShareRateBook, useShareRates }', {
    ...service, shareRateKey, feedData,
    usePublicFeed: <T>(key: string): FeedState<T> => scheduler.read<T>(key),
    useCallback: (callback: unknown, deps: unknown[]) => {
      if (!previous || deps.some((dep, i) => dep !== previous?.deps[i])) previous = { deps, callback };
      return previous.callback;
    },
  });
  return { clock, scheduler, service, hooks, heads, multicalls, live,
    setFailure: (value: boolean) => { failHistory = value; } };
}

describe('scheduled share-rate consumers', () => {
  test('cache reads never fetch; bootstrap covers every configured share and updates hooks', async () => {
    const f = setup();
    for (let i = 0; i < 5; i++) {
      expect(f.hooks.useShareRateBook()).toBeNull();
      expect(f.hooks.useShareRates().loading).toBe(true);
    }
    expect(f.heads).toEqual([]);
    expect(f.multicalls).toEqual([]);
    expect(f.live).toEqual([]);
    f.scheduler.start();
    await f.clock.advanceTo(123_456);
    const book = f.hooks.useShareRateBook()!;
    expect(book.size).toBe(3);
    expect(f.heads.map((read) => read.chain)).toEqual([1, 10]);
    expect(new Set(f.multicalls.map((read) => read.chain))).toEqual(new Set([1, 10]));
    expect(f.live.map((read) => [read.chain, read.share])).toEqual(f.service.SHARE_DEPLOYMENTS.map((ref) => [ref.chainId, ref.share]));
    const rates = f.hooks.useShareRates();
    expect(rates.loading).toBe(false);
    for (const ref of f.service.SHARE_DEPLOYMENTS) {
      expect(book.get(shareRateKey(ref.chainId, ref.share))?.current).not.toBeNull();
      expect(rates.rateFor(ref.chainId, ref.share)?.assetsPerShare).toBe(10n ** 18n + 123_456n);
    }
    expect(rates.rateFor(1, undefined)).toBeUndefined();
    await f.clock.advanceTo(150_007);
    const counts = [f.heads.length, f.multicalls.length, f.live.length];
    const unsubscribe = f.scheduler.subscribe(f.service.FEED_SHARE_RATE_BOOK, () => {});
    for (let i = 0; i < 5; i++) {
      expect(f.hooks.useShareRateBook()).toBe(book);
      expect(f.hooks.useShareRates().rateFor).toBe(rates.rateFor);
    }
    unsubscribe();
    expect([f.heads.length, f.multicalls.length, f.live.length]).toEqual(counts);
    f.scheduler.stop();
  });

  test('live reads tick each minute while historical RPCs refresh on snapped ten-minute boundaries', async () => {
    const f = setup();
    f.scheduler.start();
    await f.clock.advanceTo(123_456);
    const firstBook = f.hooks.useShareRateBook()!;
    const firstRateFor = f.hooks.useShareRates().rateFor;
    await f.clock.advanceTo(599_999);
    expect(f.heads).toEqual([{ chain: 1, at: 123_456 }, { chain: 10, at: 123_456 }]);
    expect([...new Set(f.live.map((read) => read.at))]).toEqual([123_456, 180_000, 240_000, 300_000, 360_000, 420_000, 480_000, 540_000]);
    expect(f.hooks.useShareRateBook()!.get([...firstBook.keys()][0])).toBe([...firstBook.values()][0]);
    expect(f.hooks.useShareRates().rateFor).not.toBe(firstRateFor);
    await f.clock.advanceTo(600_000);
    expect(f.heads).toEqual([
      { chain: 1, at: 123_456 }, { chain: 10, at: 123_456 }, { chain: 1, at: 600_000 }, { chain: 10, at: 600_000 },
    ]);
    expect(f.multicalls.every((read) => read.at === 123_456 || read.at === 600_000)).toBe(true);
    const ref = f.service.SHARE_DEPLOYMENTS[0];
    expect(f.hooks.useShareRateBook()!.get(shareRateKey(ref.chainId, ref.share))?.current?.assetsPerShare).toBe(10n ** 18n + 600_000n);
    expect(f.hooks.useShareRates().rateFor(ref.chainId, ref.share)?.assetsPerShare).toBe(10n ** 18n + 600_000n);
    f.scheduler.stop();
  });

  test('resolved total failure retries only at the next fixed minute, never on off-grid reads', async () => {
    const f = setup();
    f.setFailure(true);
    f.scheduler.start();
    await f.clock.advanceTo(123_456);
    expect([...f.hooks.useShareRateBook()!.values()].every((s) => s.current === null)).toBe(true);
    const calls = f.multicalls.length;
    expect(calls).toBeGreaterThan(0);
    f.setFailure(false);
    await f.clock.advanceTo(179_999);
    for (let i = 0; i < 5; i++) {
      f.hooks.useShareRateBook();
      f.hooks.useShareRates();
    }
    expect(f.heads.length).toBe(2);
    expect(f.multicalls.length).toBe(calls);
    await f.clock.advanceTo(180_000);
    expect(f.heads.map((read) => read.at)).toEqual([123_456, 123_456, 180_000, 180_000]);
    expect(f.multicalls.length).toBe(calls * 2);
    expect([...f.hooks.useShareRateBook()!.values()].every((s) => s.current != null)).toBe(true);
    f.scheduler.stop();
  });

  test('a scheduled resolution publishes a populated book independently of consumer actions', async () => {
    let resolve!: () => void;
    const headGate = new Promise<void>((yes) => { resolve = yes; });
    const f = setup({ headGate });
    let updates = 0;
    const unsubscribe = f.scheduler.subscribe(f.service.FEED_SHARE_RATE_BOOK, () => { updates++; });
    f.scheduler.start();
    await f.clock.advanceTo(123_456);
    expect(f.hooks.useShareRateBook()).toBeNull();
    expect(f.heads.length).toBe(2);
    resolve();
    await settle();
    expect(updates).toBe(1);
    expect(f.hooks.useShareRateBook()?.size).toBe(3);
    expect(f.hooks.useShareRates().loading).toBe(false);
    unsubscribe();
    f.scheduler.stop();
  });

  test('an empty build scope is a local no-op and never shows live-rate loading', async () => {
    const f = setup({ empty: true });
    expect(f.hooks.useShareRates().loading).toBe(false);
    f.scheduler.start();
    await f.clock.advanceTo(180_000);
    expect(f.hooks.useShareRateBook()?.size).toBe(0);
    expect([f.heads.length, f.multicalls.length, f.live.length]).toEqual([0, 0, 0]);
    f.scheduler.stop();
  });
});

function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

describe('share-rate network ownership', () => {
  test('audit and accounting use unconditional cache hooks, never loaders', () => {
    for (const [path, name] of [
      ['components/audit-verify-view.tsx', 'AuditVerifyView'],
      ['components/accounting-modal-provider.tsx', 'AccountingModalProvider'],
    ]) {
      const file = source(path);
      const component = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name) as ts.FunctionDeclaration;
      expect(component.body?.statements.some((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((d) =>
        d.initializer && ts.isCallExpression(d.initializer) && d.initializer.expression.getText(file) === 'useShareRateBook'))).toBe(true);
      const forbidden: string[] = [];
      walk(file, (node) => {
        if (ts.isIdentifier(node) && ['loadShareRateBook', 'loadRatesIfShare', 'fetchShareRateBook', 'fetchShareRates'].includes(node.text)) forbidden.push(node.text);
      });
      expect(forbidden).toEqual([]);
    }
  });

  test('the share-rate hook contains no query or network-capable functions', () => {
    const forbidden: string[] = [];
    walk(source('hooks/use-share-rates.ts'), (node) => {
      if (ts.isIdentifier(node) && ['useQuery', 'readShareRateSeries', 'fetchShareRateBook', 'fetchShareRates',
        'fetchAssetsPerShare', 'createPublicClient', 'policedHttp', 'fetch', 'refetch', 'enabled'].includes(node.text)) forbidden.push(node.text);
    });
    expect(forbidden).toEqual([]);
  });

  test('only the static public-feed registry consumes the production fetchers', () => {
    const callers: string[] = [];
    function scan(directory: string) {
      for (const entry of readdirSync(new URL(`${directory}/`, root), { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!['__tests__', 'tests', 'node_modules'].includes(entry.name)) scan(path);
        } else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
          walk(source(path), (node) => {
            if (!ts.isIdentifier(node) || !['fetchShareRateBook', 'fetchShareRates'].includes(node.text)) return;
            if (ts.isImportSpecifier(node.parent) || ts.isFunctionDeclaration(node.parent)) return;
            callers.push(`${path}:${node.text}`);
          });
        }
      }
    }
    for (const directory of ['app', 'components', 'hooks', 'services', 'config', 'scripts']) scan(directory);
    expect(callers.sort()).toEqual(['services/public-feeds.ts:fetchShareRateBook', 'services/public-feeds.ts:fetchShareRates']);
  });
});
