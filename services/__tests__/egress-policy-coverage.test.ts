import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { AddressSchema, HttpASPDataProvider, RelayerInteractor } from '@privacy-pools-v2/sdk';
import type { IHTTPClient } from '@privacy-pools-v2/sdk';
import * as policy from '@/services/egress-policy';
import * as egressFetch from '@/services/egress-fetch';
import * as aspBackoffModule from '@/services/asp-backoff';
import { FetchHTTPClient } from '@/services/egress-http-client';
import * as entrypointsNormalize from '@/services/entrypoints-normalize';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const ASP = 'https://asp.example';
const RELAYER = 'https://relayer.example';
const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const HASH = `0x${'1'.repeat(64)}` as const;
const source = (file: string) => readFileSync(join(ROOT, file), 'utf8');

// The policy SHIPS in report mode (see services/egress-policy.ts). Every
// assertion in this file is about a request being stopped, so it has to pin
// enforcement rather than inherit whatever the deployed default happens to be.
beforeAll(() => policy.setEgressMode('enforce'));

// Execute the actual APIClient, replacing only native environment configuration.
// No global module mocks: they would leak into the rest of the Bun test suite.
function loadApi(legacy: boolean) {
  const exports: Record<string, unknown> = {};
  const code = ts.transpileModule(source('services/api-client.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const require = (name: string) => {
    if (name === '@/config/env') return { ASP_URL: ASP, LEGACY_CONFIG: legacy ? { mtId: 305 } : undefined };
    if (name === '@/services/egress-policy') return policy;
    if (name === '@/services/egress-fetch') return egressFetch;
    if (name === '@/services/asp-backoff') return aspBackoffModule;
    if (name === '@/services/entrypoints-normalize') return entrypointsNormalize;
    throw new Error(`Unexpected APIClient dependency: ${name}`);
  };
  new Function('require', 'exports', code)(require, exports);
  return exports as { APIClient: typeof import('@/services/api-client').APIClient };
}

type Captured = { url: string; init?: RequestInit };
async function capture(run: (sent: Captured[]) => Promise<void>) {
  const sent: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), init });
    return Response.json({});
  }) as typeof fetch;
  try { await run(sent); } finally { globalThis.fetch = original; }
}

// Select the real scoping function with the TS parser, retaining its behavior
// while supplying an entrypoint resolver instead of booting react-native.
function scopedClient(inner: IHTTPClient): IHTTPClient {
  const ast = ts.createSourceFile('sdk-setup.ts', source('services/sdk-setup.ts'), ts.ScriptTarget.Latest, true);
  const node = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'createEntrypointScopedHttpClient');
  if (!node) throw new Error('SDK scoping function missing');
  const code = ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('resolveConfiguredEntrypoint', `${code}; return createEntrypointScopedHttpClient;`)(async () => ADDRESS)(inner, 11155111);
}

describe('real request construction reaches the egress allowlist', () => {
  test('every APIClient method, with optional params, headers, intents and legacy routing', async () => {
    await capture(async (sent) => {
      const touched = new Set<string>();
      for (const legacy of [false, true]) {
        const { APIClient } = loadApi(legacy);
        const api = new APIClient(ASP);
        const cases: [string, () => Promise<unknown>][] = [
          ['getHealth', () => api.getHealth(11155111)],
          ['getASPHealth', () => api.getASPHealth(11155111)],
          ['getLeafHealth', () => api.getLeafHealth(11155111)],
          ['getGlobalEvents', () => api.getGlobalEvents()],
          ['getGlobalEvents', () => api.getGlobalEvents({ page: 2, perPage: 100, action: 'transfer', status: 'pending', chainId: 11155111, token: ADDRESS, includeRagequit: true, entrypoint: ADDRESS })],
          ['getGlobalStatistics', () => api.getGlobalStatistics()],
          ['getAssetStatistics', () => api.getAssetStatistics(11155111, ADDRESS)],
          ['getTokenPrices', () => api.getTokenPrices()],
          ['getTokenPrices', () => api.getTokenPrices('11155111')],
          ['getAssetsStats', () => api.getAssetsStats('all')],
          ['getYieldDeposits', () => api.getYieldDeposits(11155111)],
          ['getYieldDeposits', () => api.getYieldDeposits(11155111, '1042')],
          ['getPpUsdcRateHistory', () => api.getPpUsdcRateHistory(11155111, '1042')],
          ['getPpUsdcVaultMetrics', () => api.getPpUsdcVaultMetrics(11155111, '90d')],
          ['getEntrypoints', () => api.getEntrypoints()],
          ['getReportAddressNonce', () => api.getReportAddressNonce(ADDRESS)],
          ['reportAddress', () => api.reportAddress({ address: ADDRESS, nonce: 'nonce', message: 'message', signature: HASH, reason: 'reason' })],
          ['getScreeningNonce', () => api.getScreeningNonce(ADDRESS)],
          ['checkWalletScreening', () => api.checkWalletScreening({ address: ADDRESS, nonce: 'nonce', message: 'message', signature: HASH })],
          ['getAssociationSetRoot', () => api.getAssociationSetRoot('11155111', ADDRESS)],
          ['getAssociationSetLeaves', () => api.getAssociationSetLeaves('11155111', ADDRESS)],
          ['getLabelStatus', () => api.getLabelStatus(HASH, '11155111', ADDRESS, 'user-initiated-audit')],
          ['getPoiRequiredLabels', () => api.getPoiRequiredLabels('11155111', ADDRESS)],
          ['getRejectedLabels', () => api.getRejectedLabels('11155111', ADDRESS)],
          ['getASPPublicKey', () => api.getASPPublicKey()],
          ['getEventSnapshotLatest', () => api.getEventSnapshotLatest(11155111, ADDRESS)],
          ['getEventSnapshot', () => api.getEventSnapshot(11155111, ADDRESS)],
          ['getEventSnapshotPayload', () => api.getEventSnapshotPayload(11155111, ['deposits', 'transacts', 'ragequits', 'leaves', 'keystoreLeaves', 'notes'], 10930000n, ADDRESS)],
          ['getEventSnapshotPayload', () => api.getEventSnapshotPayload(11155111)],
          ['getPointsEpochs', () => api.getPointsEpochs(11155111)],
          ['getPointsEpochs', () => api.getPointsEpochs(11155111, ADDRESS, '7')],
          ['getPointsRateLeaves', () => api.getPointsRateLeaves(11155111, 3n, ADDRESS)],
        ];
        for (const [name, call] of cases) {
          const before = sent.length;
          await call();
          expect(sent.length).toBe(before + 1);
          touched.add(name);
        }
        const publicMethods = Object.getOwnPropertyNames(APIClient.prototype).filter((name) => !['constructor', 'request', 'buildQuery'].includes(name));
        expect([...touched].sort()).toEqual(publicMethods.sort());
      }
      const event = sent.find((r) => r.url.includes('perPage='));
      expect(new URL(event!.url).searchParams.size).toBe(8);
      const asset = sent.find((r) => r.url.includes('/asset-statistics'));
      expect(new Headers(asset!.init?.headers).get('x-asset')).toBe(ADDRESS);
      expect(sent.some((r) => r.url === `${ASP}/association-set/305/leaves`)).toBe(true);
      // The epoch rows carry Hex epoch numbers; the rate-leaves path stays decimal.
      expect(sent.some((r) => new URL(r.url).pathname === '/11155111/public/points/epochs/3/rate-leaves')).toBe(true);
      expect(sent.some((r) => r.url.includes('include=deposits%2Ctransacts%2Cragequits%2Cleaves%2CkeystoreLeaves%2Cnotes&sinceBlock=10930000&entrypoint='))).toBe(true);
      const paths = [...sent.map((r) => new URL(r.url).pathname), '/11155111/public/note-events', '/11155111/public/viewing-keys'];
      expect(policy.ASP_ROUTES.filter((route) => !paths.some((path) => route.path.test(path)))).toEqual([]);
    });
  }, 20_000);

  test('APIClient rejects targeted and header regressions before fetch', async () => {
    await capture(async (sent) => {
      const { APIClient } = loadApi(false);
      const api = new APIClient(ASP);
      // Exercise all legal RequestInit header representations at the actual
      // boundary, including ones object-spread used to silently discard.
      const request = api as unknown as { request(path: string, init?: RequestInit): Promise<unknown> };
      for (const headers of [{ 'X-Labels': HASH }, new Headers({ 'X-Labels': HASH }), [['X-Labels', HASH]] as [string, string][]]) {
        await expect(request.request('/public-key', { headers })).rejects.toBeInstanceOf(policy.EgressRefusedError);
      }
      expect(sent.length).toBe(0);
    });
  });

  /**
   * Every URL the VENDORED SDK can build, read out of the installed bundle.
   *
   * This test exists in this form because the previous one lied. It was
   * written while node_modules held a DIFFERENT SDK build than the tarball
   * package.json pins (the worktree's node_modules had been hard-linked from
   * a checkout on another build). Against the real ab0d93bc bundle the old
   * expectations named two routes that do not exist (`/fees`,
   * `/status/{hash}`) and missed six that do: the batch and swap quotes, and
   * the register-and-withdrawal, relay-and-announce, relay-swap and batch
   * relays. The route table had the same six holes.
   *
   * So: no handwritten list of method names, and nothing driven through the
   * SDK's own parameter validation, which is what made the old test fragile
   * enough to be wrong without failing. The templates are extracted, rendered
   * into concrete URLs, and put through the policy. A newly vendored SDK that
   * adds a route fails here, loudly, with the route in the message.
   */
  /**
   * The field names a relay body can carry, read out of the vendored SDK's own
   * zod schemas rather than copied into this file by hand.
   *
   * The hand-copied list below this was wrong and did not fail: it omitted
   * `processorAddress` and `minUnderlyingOut`, which `WithdrawalRelayParamsSchema`
   * adds for yield routing, so the policy refused every relayed withdrawal from
   * a share pool the moment it went to enforce. Since ppETH and ppUSDC ARE the
   * open pools, that was every withdrawal. A list that agrees with itself
   * proves nothing; this one has to agree with the SDK.
   *
   * Follows `z.object({...})` and any chain of `X.extend({...})`. The schemas
   * are type-only exports, so they cannot be imported and inspected at runtime.
   */
  function sdkSchemaKeys(name: string): string[] {
    const sdk = ts.createSourceFile('sdk.js', source('node_modules/@privacy-pools-v2/sdk/dist/index.js'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declarations = new Map<string, ts.Expression>();
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (!declarations.has(node.name.text)) declarations.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(sdk);

    const literalKeys = (object: ts.Expression): string[] =>
      ts.isObjectLiteralExpression(object)
        ? object.properties.flatMap((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? [p.name.text] : []))
        : [];

    const resolve = (schema: string, seen = new Set<string>()): string[] => {
      if (seen.has(schema)) return [];
      seen.add(schema);
      const init = declarations.get(schema);
      if (!init || !ts.isCallExpression(init) || !ts.isPropertyAccessExpression(init.expression)) return [];
      const method = init.expression.name.text;
      const arg = init.arguments[0];
      const own = arg ? literalKeys(arg) : [];
      if (method === 'object') return own;
      // `swapQuoteParamsSchema = transferQuoteParamsSchema.extend({...}).superRefine(...)`:
      // a refinement keeps the keys of the schema it wraps.
      if (['superRefine', 'refine', 'strict', 'passthrough'].includes(method)) {
        const inner = init.expression.expression;
        if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression)) {
          const synthetic = `__inner_${schema}`;
          declarations.set(synthetic, inner);
          return resolve(synthetic, seen);
        }
        return ts.isIdentifier(inner) ? resolve(inner.text, seen) : [];
      }
      if (method === 'extend') {
        const base = init.expression.expression;
        return [...new Set([...(ts.isIdentifier(base) ? resolve(base.text, seen) : []), ...own])];
      }
      // A plain alias, `var TransferRelayParamsSchema = RelayParamsSchema`.
      return own;
    };

    const init = declarations.get(name);
    if (init && ts.isIdentifier(init)) return resolve(init.text);
    // The split SDK builds the address-carrying schemas in one factory,
    // `makeRelayerAddressSchemas(addressSchema)`, and exports the EVM instance as
    // `var WithdrawalRelayParamsSchema = evmRelayerAddressSchemas.withdrawalRelayParamsSchema`.
    // A schema nothing in the bundle reads is tree-shaken down to the bare
    // expression, so its `var` is gone. Either way the body is the factory's
    // local of the same name in lowerCamelCase, so resolve that.
    if (init && ts.isPropertyAccessExpression(init)) return resolve(init.name.text);
    const local = name[0]!.toLowerCase() + name.slice(1);
    if (!init && declarations.has(local)) return resolve(local);
    return resolve(name);
  }

  function sdkUrlTemplates(): string[] {
    const sdk = ts.createSourceFile('sdk.js', source('node_modules/@privacy-pools-v2/sdk/dist/index.js'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const templates: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isTemplateExpression(node) && node.head.text === '') {
        const first = node.templateSpans[0];
        if (first && ['this.aspUrl', 'relayer.url'].includes(first.expression.getText(sdk))) {
          templates.push(node.getText(sdk).replace(/^`|`$/g, '').replace(/\s+/g, ''));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sdk);
    return templates;
  }

  /** The share address a yield-feed request carries: build config, never user data. */
  const SHARE = '0xc246afb23482ff9596e9cee5f1f678efe0eb1ad6';
  const YIELD_FEEDS = ['ppusdc-rate-history', 'yield-deposits'] as const;

  /**
   * The yield-feed URLs exactly as the vendored SDK builds them, bootstrap and
   * resumed. The route text alone cannot say which params these send (both
   * build a URLSearchParams in a closure), and a hand-written query here once
   * had `asset=` on yield-deposits, which the SDK never sends. So run the SDK's
   * own `urlFor` closures: the provider's drain is swapped for one that calls
   * them with no cursor and with one, and makes no request.
   */
  let sdkYieldUrls: Record<(typeof YIELD_FEEDS)[number], string[]>;
  beforeAll(async () => {
    const provider = new HttpASPDataProvider({ aspUrl: ASP, chainId: 11155111, entrypointAddress: ADDRESS, httpClient: { get: async () => { throw new Error('no request'); } } } as never);
    const urls: string[] = [];
    (provider as unknown as { drainYieldFeed: (urlFor: (cursor?: string) => string) => Promise<null> }).drainYieldFeed = async (urlFor) => {
      urls.push(urlFor(undefined), urlFor('1272'));
      return null;
    };
    await provider.getYieldRateSeries(SHARE as never);
    await provider.getYieldDepositFacts(SHARE as never);
    const paths = urls.map((u) => u.slice(ASP.length));
    sdkYieldUrls = Object.fromEntries(YIELD_FEEDS.map((feed) => [feed, paths.filter((u) => u.includes(`/public/${feed}`))])) as typeof sdkYieldUrls;
  });

  /** The resumed URL the SDK builds for this yield route, or null for any other route. */
  function sdkYieldUrl(template: string): string | null {
    const feed = YIELD_FEEDS.find((f) => template.includes(`/public/${f}`));
    if (!feed) return null;
    const url = sdkYieldUrls[feed].find((u) => u.includes('sinceId='));
    if (!url) throw new Error(`SDK built no resumed URL for ${feed}`);
    return url;
  }

  /** Render a template into a real path, with our own values. */
  function render(template: string, chainType: 'evm' | 'sui'): string {
    // The yield feeds share the generic placeholders with note-events but
    // send different params; take them from the SDK's own construction above.
    const yieldUrl = sdkYieldUrl(template);
    if (yieldUrl) return yieldUrl;
    return template
      .replace('${relayer.url}', '')
      .replace('${this.aspUrl}', '')
      .replace('${relayer.chainType}', chainType)
      .replace('${relayer.chainId}', '11155111')
      .replace('${this.chainId}', '11155111')
      .replace('${this.entrypointAddress}', ADDRESS)
      .replace('${decimalLabel}', '12345678901234567890')
      .replace('${params.toString()}', 'since=10930000&until=10930500');
  }

  test('the SDK route inventory is exactly what we think it is', () => {
    const rendered = sdkUrlTemplates().map((t) => render(t, 'evm')).sort();
    expect(rendered).toEqual([
      `/11155111/public/event-snapshot/payload?entrypoint=${ADDRESS}`,
      '/11155111/public/note-events?since=10930000&until=10930500',
      // The yield feeds, as the SDK builds them (v2-monorepo#431): the rate
      // history names the share (build config), the deposits feed is the whole
      // chain's, and both carry only the server's row cursor beyond that. ppv2
      // also fetches both itself (services/yield-feed-grid.ts).
      `/11155111/public/ppusdc-rate-history?asset=${SHARE}&sinceId=1272`,
      '/11155111/public/yield-deposits?sinceId=1272',
      `/association-set/leaves?chainId=11155111&entrypoint=${ADDRESS}`,
      `/association-set/root?chainId=11155111&entrypoint=${ADDRESS}`,
      '/labels/12345678901234567890/status',
      '/public-key',
      '/v1/details/evm/11155111',
      '/v1/quote/evm/11155111/batch',
      '/v1/quote/evm/11155111/receive',
      '/v1/quote/evm/11155111/swap',
      '/v1/quote/evm/11155111/transfer',
      '/v1/relay/evm/11155111/batch',
      '/v1/relay/evm/11155111/register-and-withdrawal',
      '/v1/relay/evm/11155111/relay-and-announce',
      '/v1/relay/evm/11155111/relay-swap',
      '/v1/relay/evm/11155111/transfer',
      '/v1/relay/evm/11155111/withdrawal',
    ].sort());
  });

  test('the policy declares every route the vendored SDK can build, on both chain types', () => {
    const refused: string[] = [];
    for (const chainType of ['evm', 'sui'] as const) {
      for (const url of sdkUrlTemplates().map((t) => render(t, chainType))) {
        const relayer = url.startsWith('/v1/');
        // Relay and quote posts; the per-chain details read (SDK 4567778d
        // getChainDetails) and everything the ASP provider builds are GETs.
        const method = relayer && !url.startsWith('/v1/details') ? 'POST' : 'GET';
        const req = { method, url, headers: { accept: 'application/json' }, body: null };
        // The per-label status route is intent-gated on purpose: the point of
        // the gate is that a background sync cannot reach it, not that the SDK
        // cannot. Declaring the intent here is what a real caller must do too.
        const intent = url.includes('/status') ? ('user-initiated-audit' as const) : undefined;
        const verdict = relayer ? policy.checkRelayerRequest(req) : policy.checkAspRequest(req, intent);
        if (!verdict.allowed) refused.push(`${chainType} ${url}: ${verdict.reason}`);
      }
    }
    expect(refused).toEqual([]);
  });

  test('the yield-feed params the policy declares are exactly what the SDK and ppv2 send', async () => {
    // Both builders, both shapes (bootstrap and resumed). A declared param
    // nobody sends is allowlist surface for free, and one that is sent but not
    // declared is an outage, so the two sets must be equal.
    const sent: string[] = [...YIELD_FEEDS.flatMap((f) => sdkYieldUrls[f])];
    await capture(async (captured) => {
      const { APIClient } = loadApi(false);
      const api = new APIClient(ASP);
      await api.getYieldDeposits(11155111);
      await api.getYieldDeposits(11155111, '1272');
      await api.getPpUsdcRateHistory(11155111, undefined, SHARE);
      await api.getPpUsdcRateHistory(11155111, '1272', SHARE);
      sent.push(...captured.map((c) => c.url.slice(ASP.length)));
    });
    for (const feed of YIELD_FEEDS) {
      const urls = sent.filter((u) => u.includes(`/public/${feed}`));
      expect(urls.length).toBe(4);
      for (const url of urls) {
        expect(policy.checkAspRequest({ method: 'GET', url, headers: { accept: 'application/json' } }).allowed).toBe(true);
      }
      const used = [...new Set(urls.flatMap((u) => [...new URL(u, ASP).searchParams.keys()]))].sort();
      const route = policy.ASP_ROUTES.find((r) => r.path.test(`/11155111/public/${feed}`));
      expect([...(route?.params ?? [])].sort()).toEqual(used);
    }
  });

  test('each declared relayer body key set matches the SDK schema for that route', () => {
    // A path that is allowed but whose body is refused is the same outage,
    // one step later. These key sets are lifted from the vendored SDK's zod
    // param schemas; a body of exactly those keys must pass.
    const bodies: Record<string, string[]> = {
      '/v1/quote/evm/11155111/transfer': ['asset', 'amount', 'commit'],
      '/v1/quote/evm/11155111/receive': ['asset', 'amount', 'commit', 'recipient', 'extraGas'],
      '/v1/quote/evm/11155111/batch': ['asset', 'commit', 'recipient', 'extraGas', 'amounts'],
      '/v1/quote/evm/11155111/swap': ['asset', 'amount', 'commit', 'recipient', 'fallbackAddress', 'outputToken', 'minOutputAmount', 'extraGas', 'swapCalldata', 'swapTarget', 'approvalAddress', 'swapValue', 'gasSwapMaxInput', 'gasSwapCalldata', 'dustRecipient', 'dustRescue'],
      '/v1/relay/evm/11155111/transfer': ['proof', 'noteData', 'signedFeeCommitment', 'inputNullifierNumber', 'outputCommitmentNumber'],
      // WithdrawalRelayParamsSchema extends the plain relay set with the yield
      // routing. These two were missing here AND in the policy, so this test
      // passed while every share-pool withdrawal was refused in production.
      '/v1/relay/evm/11155111/withdrawal': ['proof', 'noteData', 'signedFeeCommitment', 'inputNullifierNumber', 'outputCommitmentNumber', 'processorAddress', 'minUnderlyingOut'],
      '/v1/relay/evm/11155111/register-and-withdrawal': ['proof', 'noteData', 'signedFeeCommitment', 'inputNullifierNumber', 'outputCommitmentNumber', 'processorAddress', 'minUnderlyingOut', 'registration'],
      '/v1/relay/evm/11155111/relay-and-announce': ['proof', 'noteData', 'signedFeeCommitment', 'inputNullifierNumber', 'outputCommitmentNumber', 'processorAddress', 'minUnderlyingOut', 'announcement'],
      '/v1/relay/evm/11155111/relay-swap': ['proof', 'noteData', 'signedSwapCommitment', 'inputNullifierNumber', 'outputCommitmentNumber'],
      '/v1/relay/evm/11155111/batch': ['items', 'signedBatchFeeCommitment'],
    };
    const refused: string[] = [];
    for (const [url, keys] of Object.entries(bodies)) {
      const body = JSON.stringify(Object.fromEntries(keys.map((k) => [k, 'x'])));
      const verdict = policy.checkRelayerRequest({ method: 'POST', url, headers: { accept: 'application/json' }, body });
      if (!verdict.allowed) refused.push(`${url}: ${verdict.reason}`);
    }
    expect(refused).toEqual([]);
    // And an undeclared field is still refused, so the sets are not just `any`.
    expect(policy.checkRelayerRequest({
      method: 'POST', url: '/v1/relay/evm/11155111/batch', headers: { accept: 'application/json' },
      body: JSON.stringify({ items: [], signedBatchFeeCommitment: 'x', label: HASH }),
    }).allowed).toBe(false);
  });

  test('the relay body sets come from the SDK schemas, not from a list in this file', () => {
    // The hand-copied set above missed the two yield-routing fields and this
    // suite still passed, while production refused every share-pool withdrawal.
    const routes: Record<string, string> = {
      '/v1/relay/evm/11155111/transfer': 'TransferRelayParamsSchema',
      '/v1/relay/evm/11155111/withdrawal': 'WithdrawalRelayParamsSchema',
      '/v1/relay/evm/11155111/register-and-withdrawal': 'RegisterAndWithdrawalRelayParamsSchema',
      '/v1/relay/evm/11155111/relay-and-announce': 'RelayAndAnnounceRelayParamsSchema',
      '/v1/relay/evm/11155111/batch': 'BatchWithdrawalRelayParamsSchema',
    };
    const refused: string[] = [];
    for (const [url, schema] of Object.entries(routes)) {
      const keys = sdkSchemaKeys(schema);
      // A schema that resolves to nothing means the derivation broke, not that
      // the route carries no fields. Fail rather than vacuously pass.
      expect(keys.length).toBeGreaterThan(0);
      const body = JSON.stringify(Object.fromEntries(keys.map((k) => [k, 'x'])));
      const verdict = policy.checkRelayerRequest({ method: 'POST', url, headers: { accept: 'application/json' }, body });
      if (!verdict.allowed) refused.push(`${url} (${schema}: ${keys.join(', ')}): ${verdict.reason}`);
    }
    expect(refused).toEqual([]);
    // The yield routing specifically, named so a future trim cannot drop it quietly.
    expect(sdkSchemaKeys('WithdrawalRelayParamsSchema')).toContain('processorAddress');
    expect(sdkSchemaKeys('WithdrawalRelayParamsSchema')).toContain('minUnderlyingOut');
    // And transfer must NOT gain them: its schema is the plain relay set.
    expect(sdkSchemaKeys('TransferRelayParamsSchema')).not.toContain('processorAddress');
  });

  test('the quote and relay-swap body sets are exactly the SDK schemas', () => {
    // The quote routes were only in the hand-copied list above, so the SDK
    // moving dustRescue from the relay-swap body into the swap quote
    // (v2-monorepo#439) passed this suite while every opted-in quote would be
    // refused. Derived from the schema each RelayerInteractor method parses.
    const routes: Record<string, string> = {
      '/v1/quote/evm/11155111/transfer': 'transferQuoteParamsSchema',
      '/v1/quote/evm/11155111/receive': 'withdrawalQuoteParamsSchema',
      '/v1/quote/evm/11155111/batch': 'batchWithdrawalQuoteParamsSchema',
      '/v1/quote/evm/11155111/swap': 'swapQuoteParamsSchema',
      '/v1/relay/evm/11155111/relay-swap': 'swapRelayParamsSchema',
    };
    // App-owned senders on the same route, named with their caller.
    const appOwned: Record<string, string[]> = {
      // services/transfer-fee-quote.ts prices the send with the amount.
      '/v1/quote/evm/11155111/transfer': ['amount'],
    };
    for (const [url, schema] of Object.entries(routes)) {
      const keys = [...new Set([...sdkSchemaKeys(schema), ...(appOwned[url] ?? [])])];
      expect(sdkSchemaKeys(schema).length).toBeGreaterThan(0);
      const route = policy.RELAYER_ROUTES.find((r) => r.method === 'POST' && r.path.test(url));
      // Equal, not a superset: an undeclared field is an outage, and a
      // declared field nobody sends is surface for free.
      expect({ url, keys: [...(route?.bodyKeys ?? [])].sort() }).toEqual({ url, keys: [...keys].sort() });
    }
    expect(sdkSchemaKeys('swapQuoteParamsSchema')).toContain('dustRescue');
  });

  test('chain details is an anchored GET route with no user fields', async () => {
    for (const chainType of ['evm', 'sui']) {
      const url = `/v1/details/${chainType}/11155111`;
      expect(policy.checkRelayerRequest({ method: 'GET', url }).allowed).toBe(true);
      for (const suffix of ['/extra', 'x', '?address=' + ADDRESS]) {
        expect(policy.checkRelayerRequest({ method: 'GET', url: url + suffix }).allowed).toBe(false);
      }
      expect(policy.checkRelayerRequest({ method: 'GET', url: '/prefix' + url }).allowed).toBe(false);
      expect(policy.checkRelayerRequest({ method: 'POST', url }).allowed).toBe(false);
      expect(policy.checkRelayerRequest({ method: 'GET', url, body: '{}' }).allowed).toBe(false);
      expect(policy.checkRelayerRequest({ method: 'GET', url, headers: { 'X-Labels': HASH } }).allowed).toBe(false);
    }
    await capture(async (sent) => {
      const endpoint = { name: 'test', url: RELAYER, chainId: 11155111, chainType: 'evm', status: 'active', address: ADDRESS, processorAddress: ADDRESS };
      const interactor = new RelayerInteractor({ relayers: [endpoint], httpClient: new FetchHTTPClient('relayer', RELAYER), addressSchema: AddressSchema } as never);
      // The empty response fails parsing, after the real SDK GET reaches fetch.
      await interactor.getChainDetails(endpoint).catch(() => undefined);
      expect(sent).toHaveLength(1);
      expect(sent[0].url).toBe(`${RELAYER}/v1/details/evm/11155111`);
      expect(sent[0].init?.method).toBe('GET');
      expect(sent[0].init?.body).toBeUndefined();
      expect(sent[0].init?.credentials).toBe('omit');
      expect(sent[0].init?.referrerPolicy).toBe('no-referrer');
      expect(sent[0].init?.redirect).toBe('error');
    });
  });

  test('real ASP provider requests pass, and the entrypoint is scoped exactly once', async () => {
    await capture(async (sent) => {
      const http = scopedClient(new FetchHTTPClient('asp', ASP, 'user-initiated-audit'));
      const provider = new HttpASPDataProvider({ aspUrl: ASP, chainId: 11155111, entrypointAddress: ADDRESS, httpClient: http } as never);
      // Response parsing is outside this test. Each invocation must reach
      // fetch once, so a refusal cannot be hidden by the SDK's error wrapper.
      for (const run of [() => provider.getRoot(), () => provider.getLeaves(), () => provider.getLabelStatus(HASH), () => provider.getASPPublicKey(), () => provider.getEventSnapshot(), () => provider.getNoteEvents('0xa6c720', '0xa6ee30')]) {
        const before = sent.length;
        await run().catch(() => undefined);
        expect(sent.length).toBe(before + 1);
      }
      // Exactly one: the SDK appends its own `entrypoint`, and so does our
      // scoping wrapper. Two would be a different request than either meant.
      for (const req of sent.filter((r) => /association-set|labels|event-snapshot/.test(r.url))) {
        expect(new URL(req.url).searchParams.getAll('entrypoint')).toEqual([ADDRESS]);
      }
      const noteEvents = sent.find((r) => r.url.includes('note-events'))!;
      // The scoping wrapper adds an `entrypoint` param to every ASP call, note-events
      // included. It is our own configured address, not a user value, and the
      // policy declares it; what matters is that nothing ELSE rides along.
      expect([...new URL(noteEvents.url).searchParams.keys()].sort()).toEqual(['entrypoint', 'since', 'until']);
      expect(policy.checkAspRequest({ method: 'GET', url: noteEvents.url, headers: { accept: 'application/json' } }).allowed).toBe(true);
      await http.get(`${ASP}/association-set/leaves?chainId=11155111&entrypoint=${ADDRESS}`);
      expect(new URL(sent[sent.length - 1]!.url).searchParams.getAll('entrypoint')).toEqual([ADDRESS]);
    });
  });

  test('relayer discovery is declared, and it is ours rather than the SDK\'s', async () => {
    // `RelayerInteractor.getRelayers()` in the vendored build returns the
    // configured list without a request, so /v1/details never appears in the
    // SDK inventory above. We fetch it ourselves, so it still has to be
    // declared, and this is the only thing that says so.
    expect(policy.checkRelayerRequest({ method: 'GET', url: `${RELAYER}/v1/details`, headers: { accept: 'application/json' } }).allowed).toBe(true);
    await capture(async (sent) => {
      const interactor = new RelayerInteractor({ relayers: [{ name: 'test', url: RELAYER, chainId: 11155111, chainType: 'evm', status: 'active', address: ADDRESS, processorAddress: ADDRESS }], httpClient: new FetchHTTPClient('relayer', RELAYER), addressSchema: AddressSchema } as never);
      await interactor.getRelayers().catch(() => undefined);
      expect(sent.length).toBe(0);
    });
  });

  test('the direct viewing-key registry feed is declared', () => {
    expect(policy.checkAspRequest({ method: 'GET', url: '/11155111/public/viewing-keys?sinceId=1042', headers: { accept: 'application/json' } }).allowed).toBe(true);
  });
});


describe('app-owned network boundary coverage', () => {
  function files(dir: string): string[] {
    return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : files(path);
      return /\.[jt]sx?$/.test(entry.name) ? [path] : [];
    });
  }

  test('all app-owned viem clients use the policed transport', () => {
    const offenders: string[] = [];
    for (const file of ['app', 'components', 'hooks', 'services', 'config'].flatMap(files)) {
      if (file === 'services/egress-transport.ts') continue;
      const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
      for (const node of ast.statements) {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
        if (!['viem', 'wagmi'].includes(node.moduleSpecifier.text)) continue;
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const binding of bindings.elements) {
            if (['http', 'webSocket', 'custom'].includes((binding.propertyName ?? binding.name).text)) offenders.push(file);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('direct fetch sites stay inventoried; new network paths require review', () => {
    const counts: Record<string, number> = {};
    for (const file of ['app', 'components', 'hooks', 'services', 'config'].flatMap(files)) {
      const ast = ts.createSourceFile(file, source(file), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'fetch') counts[file] = (counts[file] ?? 0) + 1;
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
    // Sui's and Stellar's separate SDK stacks and explicit third-party services
    // are outside the EVM boundary. Inventory is not a runtime sandbox for them.
    expect(counts).toEqual({
      'components/newsletter-modal.tsx': 1,
      'hooks/use-stellar-balance.ts': 1, // Horizon account balance (the wallet's own, public)
      'hooks/use-sui-proof.ts': 2,
      'hooks/use-sui-relay.ts': 2,
      'services/fx-rate.ts': 1,
      'services/lifi-quote.ts': 2,
      'services/lifi-token-list.ts': 1, // whole-chain token list, names no wallet
      'services/price-service.ts': 1,
      'services/sdk-setup.ts': 1, // circuit artifacts, not the ASP client
      // Stellar testnet: its own SDK/Soroban/Horizon stack, like Sui's.
      'services/stellar/stellar-account.ts': 1, // testnet relayer details, before a withdrawal
      'services/stellar/stellar-relayer.ts': 1, // testnet relayer quote + relay
      'services/stellar/stellar-runtime.ts': 2, // asp-v2 events + ASP data, and circuit artifacts
      'services/sui-witness/asp-labels.ts': 1,
      'services/tor-fetch.ts': 2, // the specifier read before Tor exists, and routedFetch's direct send when Tor is off
      'services/wallet-tokens.ts': 1, // Alchemy token REST API, not JSON-RPC
    });
  });
});
