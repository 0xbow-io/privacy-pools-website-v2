import { applySharePriceFallback, sharePriceKeys } from '@/services/share-price-rule';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { ScopedTtlCache } from '../scoped-ttl-cache';
import { confirmSpendableCommitments } from '../leaf-gate';
import { foldRowsPerAsset } from '../stats-asset-fold';
import { LABEL_DECISIONS_INTERVAL_MS, LABEL_DECISIONS_MAX_AGE_MS, readLabelDecisions } from '../label-decision-feed';

const source = (path: string) => ts.createSourceFile(path,
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function evaluate(code: string, env: Record<string, unknown>) {
  return new Function(...Object.keys(env), ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText)(...Object.values(env));
}
function find(root: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node {
  if (predicate(root)) return root;
  let result: ts.Node | undefined;
  root.forEachChild((node) => { if (!result) { try { result = find(node, predicate); } catch {} } });
  if (!result) throw new Error('Production node not found');
  return result;
}
const cache = source('services/public-asp-cache.ts');
const fn = (name: string) => find(cache, (n) => ts.isFunctionDeclaration(n) && n.name?.text === name)
  .getText(cache).replace(/^export /, '');
const normalizeHashString = evaluate(`${fn('normalizeHashString')}; return normalizeHashString;`, {});
const hash = normalizeHashString('171');

test('decimal, short hex and uppercase decision hashes identify the same label', () => {
  for (const value of ['171', '0xab', '0X00AB', hash]) expect(normalizeHashString(value)).toBe(hash);
});

// A snapshot the grid has not delivered, or one past its age bound, must read
// as "unknown" and stop the caller — never as an empty set, which would read as
// "nothing is blocked".
test('an absent or stale decision snapshot fails closed', () => {
  for (const state of [
    { status: 'empty' },
    { status: 'error', error: new Error('down'), at: 0 },
  ]) {
    const decisions = evaluate(`${fn('getPoolLabelDecisions')}; return getPoolLabelDecisions;`, {
      LEGACY_CONFIG: false,
      publicFeeds: { read: () => state },
      feedLabelDecisions: (chainId: number) => `label-decisions:${chainId}`,
      readLabelDecisions,
      Date,
    });
    expect(() => decisions(1)).toThrow('ASP label decisions unavailable');
  }
  // And one that arrived, but too long ago to authorise a spend.
  const stale = evaluate(`${fn('getPoolLabelDecisions')}; return getPoolLabelDecisions;`, {
    LEGACY_CONFIG: false,
    publicFeeds: { read: () => ({ status: 'ready', data: { rejected: [], poiRequired: [], entrypoint: '0x1' }, at: 0 }) },
    feedLabelDecisions: (chainId: number) => `label-decisions:${chainId}`,
    readLabelDecisions,
    Date: { now: () => LABEL_DECISIONS_MAX_AGE_MS },
  });
  expect(() => stale(1)).toThrow('ASP label decisions unavailable');
});

test('SDK status gives decisions precedence over published membership without targeted queries', async () => {
  const setup = source('services/sdk-setup.ts');
  const property = find(setup, (n) => ts.isPropertyAssignment(n) && n.name.getText(setup) === 'getLabelStatus') as ts.PropertyAssignment;
  for (const status of ['rejected', 'poi_required', 'approved', 'pending']) {
    const read = evaluate(`return (${property.initializer.getText(setup)});`, {
      LEGACY_CONFIG: false, normalizeHashString, chainId: 1, baseProvider: {},
      // Synchronous now: reading decisions cannot put a request on the wire.
      getPoolLabelDecisions: () => ({
        rejected: new Set(status === 'rejected' ? [hash] : []),
        poiRequired: new Set(['rejected', 'poi_required'].includes(status) ? [hash] : []),
      }),
      bulkApprovedLabels: async () => new Set(status === 'pending' ? [] : [hash]),
    });
    expect(await read('0xAB')).toEqual({ status });
  }
});

// The SDK Promise.all's this per unique label during discovery, so a throw here
// would kill the whole sync. 'pending' is the fail-closed answer: it promotes
// nothing and demotes nothing.
test('an unusable decision snapshot leaves a label pending rather than killing discovery', async () => {
  const setup = source('services/sdk-setup.ts');
  const property = find(setup, (n) => ts.isPropertyAssignment(n) && n.name.getText(setup) === 'getLabelStatus') as ts.PropertyAssignment;
  let approvedAsked = false;
  const read = evaluate(`return (${property.initializer.getText(setup)});`, {
    LEGACY_CONFIG: false, normalizeHashString, chainId: 1, baseProvider: {},
    getPoolLabelDecisions: () => { throw new Error('ASP label decisions unavailable'); },
    bulkApprovedLabels: async () => { approvedAsked = true; return new Set([hash]); },
  });
  expect(await read('0xAB')).toEqual({ status: 'pending' });
  // And membership alone must not be able to answer 'approved' in that state.
  expect(approvedAsked).toBe(false);
});

test('a POI decision vetoes a published leaf in UI eligibility', () => {
  const notes = [{ commitment: 'blocked', label: '171' }, { commitment: 'approved', label: '172' }];
  expect([...confirmSpendableCommitments({ notes, leaves: ['171', '172'],
    blockedLabelHashes: ['0X00AB'], hashLabel: String })]).toEqual(['approved']);
});

test('every session transaction checks current decisions before building its witness', async () => {
  const session = source('services/pool-session-service.ts');
  const assignment = find(session, (n) => ts.isBinaryExpression(n)
    && n.left.getText(session) === 'witnessService.buildTransactWitness');
  let builds = 0;
  let unavailable = false;
  let reads = 0;
  const service = { buildTransactWitness: async (_inputs: unknown) => { builds++; return 'witness'; } };
  evaluate(`${assignment.getText(session)};`, {
    witnessService: service, buildTransactWitness: service.buildTransactWitness,
    chainId: 1, normalizeHashString, hashService: { hash: ([label]: string[]) => label },
    // Synchronous, and takes no options: there is no door here through which a
    // spend can cause a request. A stub that returned a promise would make the
    // `.has` below throw, which is the shape of the bug this pins.
    getPoolBlockedLabelHashes: (_chain: number) => {
      reads++;
      if (unavailable) throw new Error('ASP label decisions unavailable');
      return new Set([hash]);
    },
  });
  await expect(service.buildTransactWitness({ inputNotes: [{ label: '0xAB', status: 'ACTIVE' }] })).rejects.toThrow('proof of innocence');
  expect(builds).toBe(0);
  expect(await service.buildTransactWitness({ inputNotes: [{ label: '172' }] })).toBe('witness');
  // An unusable snapshot stops the spend, in the user's words, without building.
  unavailable = true;
  await expect(service.buildTransactWitness({ inputNotes: [{ label: '172' }] })).rejects.toThrow('still spendable');
  expect(builds).toBe(1);
  expect(reads).toBe(3);
});

test('raw and mapped prices share pending requests, isolate chains and retry failures', async () => {
  const prices = source('services/price-service.ts');
  const code = prices.statements.filter((n) => !ts.isImportDeclaration(n))
    .map((n) => n.getText(prices).replace(/^export /, '')).join('\n');
  const calls: string[] = [];
  let fail = false;
  const { getTokenPrices, getAllPrices } = evaluate(`${code}; return { getTokenPrices, getAllPrices };`, {
    ScopedTtlCache, applySharePriceFallback, sharePriceKeys, getConfiguredYieldDeployments: () => [], ALCHEMY_KEY: '', ACTIVE_ENVIRONMENT: { tokensByChain: {} },
    resolveTokenMetadata: (symbol: string) => ({ symbol, address: '' }),
    apiClient: { getTokenPrices: async (chain: string) => {
      calls.push(chain);
      if (fail) throw new Error('offline');
      return { prices: [{ tokenSymbol: 'USDC', chainId: chain, priceUsd: '1' }] };
    } },
  });
  const [raw, mapped] = await Promise.all([getTokenPrices('1'), getAllPrices('1')]);
  expect(raw.prices).toHaveLength(1);
  expect(mapped.USDC).toBe(1);
  expect(calls).toEqual(['1']);
  await getTokenPrices('10');
  fail = true;
  await expect(getTokenPrices('11155111')).rejects.toThrow('offline');
  fail = false;
  await getTokenPrices('11155111');
  expect(calls).toEqual(['1', '10', '11155111', '11155111']);
});

// The Alchemy fallback used to write ETH's price to the 0xEeee… native
// sentinel on EVERY chain, because the key is the same everywhere. On Citrea
// (native cBTC) and BSC (native BNB) that CLOBBERED the correct figure the row
// loop had already written from the chain's own price, so a cBTC balance was
// valued in ether. Two screens carried a guard apologising for it.
test('the shared native sentinel is only written for a chain whose native is ether', async () => {
  const prices = source('services/price-service.ts');
  const code = prices.statements.filter((n) => !ts.isImportDeclaration(n))
    .map((n) => n.getText(prices).replace(/^export /, '')).join('\n');
  const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const run = (chainId: string, nativeSymbol: string, nativePrice: number) => evaluate(
    `${code}; return getAllPrices;`,
    {
      ScopedTtlCache,
      applySharePriceFallback, sharePriceKeys, getConfiguredYieldDeployments: () => [],
      ALCHEMY_KEY: 'key',
      ACTIVE_ENVIRONMENT: {
        tokensByChain: { [Number(chainId)]: { native: { symbol: nativeSymbol, address: NATIVE, decimals: 18 } } },
      },
      resolveTokenMetadata: (symbol: string) => ({ symbol, address: symbol === nativeSymbol ? NATIVE : '' }),
      apiClient: {
        getTokenPrices: async () => ({ prices: [{ tokenSymbol: nativeSymbol, chainId, priceUsd: String(nativePrice) }] }),
      },
      // The fallback fires because ETH is missing from the chain's own rows.
      // Shaped like the real Alchemy response: without `currency` the parser
      // finds no USD entry, the fallback contributes nothing, and this test
      // would pass without exercising the sentinel line at all.
      fetch: async () => ({ ok: true, json: async () => ({ data: [{ symbol: 'ETH', prices: [{ currency: 'usd', value: '2500' }] }] }) }),
    },
  )(chainId);

  // Citrea keeps cBTC's number under the sentinel, not ether's.
  const citrea = await run('4114', 'CBTC', 61000);
  expect(citrea[NATIVE]).toBe(61000);
  // Mainnet still gets the sentinel filled when the feed itself returns 0.00.
  const mainnet = await run('1', 'ETH', 2500);
  expect(mainnet[NATIVE]).toBe(2500);
});

test('public price and gas price feeds register every build-supported EVM chain exactly once', async () => {
  const feeds = source('services/public-feeds.ts');
  const code = feeds.statements.filter((n) => !ts.isImportDeclaration(n))
    .map((n) => n.getText(feeds).replace(/^export /, '')).join('\n');
  const registrations: { key: string; fetch: () => unknown }[] = [];
  const env = (pointsEnabled: boolean, target: typeof registrations): Record<string, unknown> => ({
    supportedEvmChainIds: [1, 10, 11155111], apiClient: {},
    fetchGasPrice: async (chain: number) => BigInt(chain),
    feedGasPrice: (chain: number) => `gas-price:${chain}`,
    GAS_PRICE_INTERVAL_MS: 60_000,
    publicFeeds: { register: (feed: typeof registrations[number]) => target.push(feed), start() {} },
    getTokenPrices: (chain: string) => `raw:${chain}`, getAllPrices: (chain: string) => `map:${chain}`,
    feedLabelDecisions: (chain: number | string) => `label-decisions:${chain}`,
    LABEL_DECISIONS_INTERVAL_MS, LABEL_DECISIONS_MAX_AGE_MS,
    aspBackoff: { onWindowEnd: () => () => {} },
    fetchPoolLabelDecisions: (chain: number) => `decisions:${chain}`,
    feedEventSnapshot: (chain: number) => `event-snapshot:${chain}`,
    EVENT_SNAPSHOT_INTERVAL_MS: 120_000,
    refreshPoolEventSnapshot: async (chain: number) => ({ snapshotBlockNumber: `snapshot:${chain}` }),
    feedPoolLeaves: (chain: number) => `pool-leaves:${chain}`,
    POOL_LEAVES_INTERVAL_MS: 120_000,
    refreshPoolLeaves: async (chain: number) => ({ snapshotBlockNumber: `leaves:${chain}` }),
    feedAssociationSet: (chain: number | string) => `association-set:${chain}`,
    ASSOCIATION_SET_INTERVAL_MS: 60_000,
    refreshPoolAssociationSet: async (chain: number) => `root:${chain}`,
    feedAssetStatistics: (chain: number | string) => `asset-statistics:${chain}`,
    ASSET_STATISTICS_INTERVAL_MS: 300_000,
    fetchAssetStatisticsFeed: async (chain: number) => `asset-statistics-fetch:${chain}`,
    FEED_ASP_PUBLIC_KEY: 'asp-public-key', ASP_PUBLIC_KEY_INTERVAL_MS: 1_800_000, ASP_PUBLIC_KEY_RETRY_MS: 15_000,
    fetchAspPublicKey: () => 'asp-public-key-fetch',
    feedPpUsdcRateHistory: (chain: number | string) => `ppusdc-rate-history:${chain}`,
    feedPpUsdcVaultMetrics: (chain: number | string) => `ppusdc-vault-metrics:${chain}`,
    fetchPpUsdcRateHistoryFeed: (chain: number) => `rate-history-fetch:${chain}`,
    fetchPpUsdcVaultMetricsFeed: (chain: number) => `vault-metrics-fetch:${chain}`,
    FULL_RESYNC_INTERVAL_MS: 60_000,
    refreshViewingKeyRegistry: (chain: number) => `viewing-key-refresh:${chain}`,
    getChainConfig: () => undefined,
    LEGACY_CONFIG: undefined,
    feedYieldDeposits: (chain: number | string) => `yield-deposits:${chain}`,
    feedYieldRateHistory: (chain: number | string, share: string) => `yield-rate-history:${chain}:${share.toLowerCase()}`,
    fetchYieldDepositsFeed: (chain: number) => `deposits-fetch:${chain}`,
    fetchYieldRateHistoryFeed: (chain: number, share: string) => `share-rate-fetch:${chain}:${share}`,
    RATE_HISTORY_INTERVAL_MS: 600_000,
    YIELD_DEPOSITS_INTERVAL_MS: 600_000,
    feedLifiVerifiedTokens: (chain: number) => `lifi-verified-tokens:${chain}`,
    fetchLifiVerifiedTokens: (chain: number) => `lifi-verified-fetch:${chain}`,
    LIFI_VERIFIED_TOKENS_INTERVAL_MS: 21_600_000,
    WALLET_TOKEN_MAINNET_IDS: [1, 56],
    FEED_SHARE_RATE_BOOK: 'share-rate-book', FEED_SHARE_RATES: 'share-rates', SHARE_RATE_INTERVAL_MS: 60_000,
    fetchShareRateBook: () => 'share-rate-book-fetch', fetchShareRates: () => 'share-rates-fetch',
    POINTS_ENABLED: pointsEnabled,
    ASP_BACKOFF_PROBE_MS: 15_000, ASP_URL: 'https://asp.example',
    probeAsp: () => undefined, startAspRequests: () => {}, stopAspRequests: () => {},
    feedPointsEpochs: (chain: number | string) => `points-epochs:${chain}`,
    fetchPointsFeed: (chain: number) => `points-fetch:${chain}`,
    POINTS_FEED_INTERVAL_MS: 1_800_000,
    // Build config: two shares on mainnet, none elsewhere.
    getConfiguredYieldDeployments: (chain: number) => (chain === 1
      ? [{ ppUSDC: '0xAAAA000000000000000000000000000000000001' }, { ppUSDC: '0xBBBB000000000000000000000000000000000002' }]
      : []),
  });
  const start = evaluate(`${code}; return startPublicFeeds;`, env(true, registrations));
  start(); start();
  // The deposit ciphertext's key: one global feed, so preparing a deposit
  // reads it instead of fetching it.
  for (const [key, result] of [['share-rate-book', 'share-rate-book-fetch'], ['share-rates', 'share-rates-fetch'],
    ['asp-public-key', 'asp-public-key-fetch']]) {
    expect(registrations.filter((f) => f.key === key).map((f) => f.fetch())).toEqual([result]);
  }
  for (const chain of [1, 10, 11155111]) {
    const gasFeeds = registrations.filter((f) => f.key === `gas-price:${chain}`);
    expect(gasFeeds).toHaveLength(1);
    expect(await gasFeeds[0].fetch()).toBe(BigInt(chain));
    expect(registrations.filter((f) => f.key === `token-prices:${chain}`).map((f) => f.fetch())).toEqual([`raw:${chain}`]);
    expect(registrations.filter((f) => f.key === `price-map:${chain}`).map((f) => f.fetch())).toEqual([`map:${chain}`]);
    // The decisions ride the same static scope set, so which chain a client is
    // on stops being visible in which feeds it asks for.
    expect(registrations.filter((f) => f.key === `label-decisions:${chain}`).map((f) => f.fetch())).toEqual([`decisions:${chain}`]);
    // The event snapshot too: refreshed by the grid for every chain, so neither
    // which chains a client holds nor when it acts decides when it is asked for.
    const snapshotFeeds = registrations.filter((f) => f.key === `event-snapshot:${chain}`);
    expect(snapshotFeeds).toHaveLength(1);
    expect(await snapshotFeeds[0].fetch()).toBe(`snapshot:${chain}`);
    // The pool state a spend proof is built against, and the association set
    // it is checked against: on the grid for every chain, so preparing a spend
    // reads copies instead of putting requests on the wire at that moment.
    for (const [key, result] of [
      [`pool-leaves:${chain}`, `leaves:${chain}`],
      [`association-set:${chain}`, `root:${chain}`],
      // And the per-asset statistics, which a pool page fetched as it opened.
      [`asset-statistics:${chain}`, `asset-statistics-fetch:${chain}`],
    ]) {
      const feeds = registrations.filter((f) => f.key === key);
      expect(feeds).toHaveLength(1);
      expect(await feeds[0].fetch()).toBe(result);
    }
    // The yield feeds ride the same static scope set. They are registered for
    // EVERY supported chain, including ones with no yield deployment, because
    // registering only the configured ones would make a client's request set
    // change the day a deployment lands — and because the three of them used
    // to be fetched from a component, where the rate history and deposit facts
    // had exactly one trigger: expanding a position's yield row.
    expect(registrations.filter((f) => f.key === `ppusdc-rate-history:${chain}`).map((f) => f.fetch())).toEqual([`rate-history-fetch:${chain}`]);
    expect(registrations.filter((f) => f.key === `ppusdc-vault-metrics:${chain}`).map((f) => f.fetch())).toEqual([`vault-metrics-fetch:${chain}`]);
    // The viewing-key registry's full re-pull rides the grid too, not a
    // per-lookup trigger — see services/viewing-key-cache.ts (review of #130).
    expect(registrations.filter((f) => f.key === `viewing-key-registry:${chain}`).map((f) => f.fetch())).toEqual([`viewing-key-refresh:${chain}`]);
    // Points epochs: every chain, whatever the wallet holds.
    expect(registrations.filter((f) => f.key === `points-epochs:${chain}`).map((f) => f.fetch())).toEqual([`points-fetch:${chain}`]);
  }
  // Yield earned's feeds (services/yield-earned.ts): the deposits feed once per
  // chain that CONFIGURES a yield deployment, and the rate history of every
  // configured share there, held or not. Both from build config, so the set is
  // the same for every client of the build.
  expect(registrations.filter((f) => f.key.startsWith('yield-deposits')).map((f) => [f.key, f.fetch()]))
    .toEqual([['yield-deposits:1', 'deposits-fetch:1']]);
  expect(registrations.filter((f) => f.key.startsWith('yield-rate-history')).map((f) => [f.key, f.fetch()])).toEqual([
    ['yield-rate-history:1:0xaaaa000000000000000000000000000000000001', 'share-rate-fetch:1:0xaaaa000000000000000000000000000000000001'],
    ['yield-rate-history:1:0xbbbb000000000000000000000000000000000002', 'share-rate-fetch:1:0xbbbb000000000000000000000000000000000002'],
  ]);
  // LiFi's verified token lists, once per mainnet the build lists wallet
  // tokens on: opening Shield used to be what fetched them.
  expect(registrations.filter((f) => f.key.startsWith('lifi-verified-tokens')).map((f) => [f.key, f.fetch()])).toEqual([
    ['lifi-verified-tokens:1', 'lifi-verified-fetch:1'],
    ['lifi-verified-tokens:56', 'lifi-verified-fetch:56'],
  ]);

  // With points disabled, no chain registers a points feed.
  const disabled: typeof registrations = [];
  evaluate(`${code}; return startPublicFeeds;`, env(false, disabled))();
  expect(disabled.length).toBeGreaterThan(0);
  expect(disabled.filter((f) => f.key.startsWith('points-epochs'))).toEqual([]);
});

test('asset counts sum across pool generations using ASP field names', () => {
  const rows = [2, 3].map((n) => ({ chainId: '1', tokenAddress: '0xabc', asset: 'USDC', tokenSymbol: 'USDC',
    growth24h: null, pendingGrowth24h: null, withdrawalsCount: n,
    transfersCount: n * 2, totalDepositsValueUsd: '0', totalInAssetValueUsd: '0', pendingDepositsValueUsd: '0' }));
  const [folded] = foldRowsPerAsset(rows, 1);
  expect(folded.withdrawalsCount).toBe(5);
  expect(folded.transfersCount).toBe(10);
});

test('missing pool scope cannot turn into a chain-wide decision request', async () => {
  // The fetcher is the only thing that touches /labels/*. Without a pool scope
  // it must refuse before the client is even reached — a chain-wide call is a
  // different question than the one we are allowed to ask.
  const fetchDecisions = evaluate(`${fn('fetchPoolLabelDecisions')}; return fetchPoolLabelDecisions;`, {
    LEGACY_CONFIG: false,
    resolveConfiguredEntrypoint: async () => undefined,
    normalizeHashString,
    // Any property access at all is a failure: an import of the client would
    // already be a request waiting to happen.
    apiClient: new Proxy({}, { get() { throw new Error('must not reach the API client without a pool'); } }),
  });
  await expect(fetchDecisions(1)).rejects.toThrow('ASP label decisions unavailable');
});
