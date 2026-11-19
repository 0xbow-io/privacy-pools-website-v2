import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { swapPreviewConfigKey } from '../swap-preview-config';

const source = readFileSync(new URL('../swap-preview-config-feed.ts', import.meta.url), 'utf8');

test('scheduled preview config reads the fixed catalog on every chain, without user inputs', async () => {
  const file = ts.createSourceFile('feed.ts', source, ts.ScriptTarget.Latest, true);
  const code = file.statements.filter((node) => !ts.isImportDeclaration(node))
    .map((node) => node.getText(file).replace(/^export /, '')).join('\n');
  const rpc: string[] = [];
  const requests: { url: string; body?: unknown }[] = [];
  let failToken = false;
  let now = 0;
  let releaseRelayer!: () => void;
  let releaseSlowChain!: () => void;
  const relayerWait = new Promise<void>(resolve => { releaseRelayer = resolve; });
  const slowChainWait = new Promise<void>(resolve => { releaseSlowChain = resolve; });
  const env = {
    Date: { now: () => now },
    SWAP_PREVIEW_CONFIG_INTERVAL_MS: 300_000,
    getChainConfig: (id: number) => ({ rpcUrls: [`https://rpc/${id}`], relayerBaseUrl: `https://relayer` }),
    getActionableTokens: (id: number) => [{ address: `token-${id}-a` }, { address: `token-${id}-b` }],
    policedHttp: (url: string) => url,
    fallback: (urls: string[]) => urls[0],
    createPublicClient: () => ({ readContract: async (args: { args: string[] }) => {
      rpc.push(args.args[0]);
      if (args.args[0].startsWith('token-10')) await slowChainWait;
      if (failToken && args.args[0] === 'token-1-a') throw new Error('offline');
      return { enabled: true, vettingFeeBPS: 5n, maxRelayFee: 10n };
    } }),
    resolveConfiguredEntrypoint: async (id: number) => `entrypoint-${id}`,
    ENTRYPOINT_ASSETS_ABI: [],
    getVettingFeeBPS: (config: { vettingFeeBPS: bigint }) => config.vettingFeeBPS,
    swapPreviewConfigKey,
    parseRelayerChainDetails: (body: unknown) => body,
    policedFetch: async (_party: string, _base: string, url: string, init: { body?: unknown }) => {
      requests.push({ url, body: init.body });
      await relayerWait;
      return { ok: true, json: async () => ({ chains: [1, 10].map(id => ({ id, assets: [{ address: `token-${id}-a`, fixedFeeAmount: '3' }] })) }) };
    },
  };
  const load = new Function(...Object.keys(env), ts.transpileModule(`${code}\nreturn fetchSwapPreviewConfigs;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText)(...Object.values(env));
  const fast = load(1);
  let slowReady = false;
  const slow = load(10).then((value: unknown) => { slowReady = true; return value; });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  // Both chains start their RPC work while the shared relayer is still pending.
  expect(rpc.sort()).toEqual(['token-1-a', 'token-1-b', 'token-10-a', 'token-10-b']);
  expect(requests).toHaveLength(1);
  releaseRelayer();
  const first = await fast;
  expect(Object.keys(first).sort()).toEqual(['1:token-1-a', '1:token-1-b']);
  expect(slowReady).toBe(false); // another chain cannot delay publication
  releaseSlowChain();
  expect(Object.keys(await slow).sort()).toEqual(['10:token-10-a', '10:token-10-b']);
  const firstReads = [...rpc].sort();
  rpc.length = 0;
  now = 300_000;
  failToken = true;
  const [second] = await Promise.all([load(1), load(10)]);
  expect([...rpc].sort()).toEqual(firstReads);
  expect(second['1:token-1-a']).toBeUndefined();
  expect(requests).toHaveLength(2); // one shared host request per fixed tick
  expect(requests.every((r) => r.body === undefined && r.url === 'https://relayer/v1/details')).toBe(true);
  expect(first['1:token-1-a'].relayerFlatFee).toBe(3n);
  const grid = readFileSync(new URL('../public-feeds.ts', import.meta.url), 'utf8');
  expect(grid).toContain('key: feedSwapPreviewConfig(chainId), intervalMs: SWAP_PREVIEW_CONFIG_INTERVAL_MS, fetch: () => fetchSwapPreviewConfigs(chainId)');
  const hub = readFileSync(new URL('../../components/home/action-hub.tsx', import.meta.url), 'utf8');
  expect(hub).not.toContain('fetchSwapPreviewConfigs');
  expect(hub).toContain('usePublicFeed<SwapPreviewConfigs>(feedSwapPreviewConfig(chainId))');
});
