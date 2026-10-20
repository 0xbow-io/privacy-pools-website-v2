import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeFunctionData, multicall3Abi } from 'viem';

import {
  ASP_ROUTES,
  assertEgressAllowed,
  checkAspRequest,
  checkRelayerRequest,
  checkRpcRequest,
  getEgressMode,
  looksHighEntropy,
  onEgressRefusal,
  setEgressMode,
  type EgressRequest,
} from '@/services/egress-policy';

const get = (url: string, headers?: Record<string, string | undefined>): EgressRequest => ({
  method: 'GET',
  url,
  headers,
});
const rpc = (body: unknown): EgressRequest => ({
  method: 'POST',
  url: 'https://eth-sepolia.g.alchemy.com/v2/key',
  body: JSON.stringify(body),
});

const LABEL = '0x2f1a4c9d1b7e6a5038f2c4d9e8b7a6150c3d2e1f0a9b8c7d6e5f40312233445';
const COMMITMENT = '19283746501928374650192837465019283746501928374650192837465019';
const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

describe('the two leaks that were actually disclosed', () => {
  test('refuses the amount-keyed deposit-count route outright', () => {
    // The route no longer exists in the client. The policy is what stops it
    // being re-added: an undeclared path is refused on sight, so bringing the
    // endpoint back means adding it here, in front of a reviewer.
    const verdict = checkAspRequest(get('/global/public/deposits-larger-than?amount=200000000000000'));
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain('not a declared ASP route');
  });

  test('refuses a label set carried in a request header', () => {
    const verdict = checkAspRequest(
      get('/global/public/statistics', { 'X-Labels': `${LABEL},${LABEL}` }),
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain("may not carry the 'x-labels' header");
  });

  test('the refusal never quotes the value it is refusing to send', () => {
    const verdict = checkAspRequest(get('/global/public/statistics', { 'X-Labels': LABEL }));
    // Assert the refusal happened BEFORE asserting what it says: a version of
    // this that folded both into one boolean passed while the header check was
    // switched off, because "not refused" made the whole expression false too.
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.reason).not.toContain(LABEL);
  });
});

describe('ASP route allowlist', () => {
  // A plain loop rather than test.each: this repo's bun:test types do not
  // declare .each, and the typecheck is a real CI gate.
  for (const url of [
    '/11155111/health/liveness',
    '/11155111/health/asp',
    '/11155111/health/leaves',
    '/global/public/statistics',
    '/global/public/entrypoints',
    '/global/public/token-prices?chainId=11155111',
    '/11155111/public/assets-stats',
    '/all/public/assets-stats',
    '/11155111/public/yield-deposits?sinceId=1042',
    '/11155111/public/ppusdc-rate-history?sinceId=1042',
    '/11155111/public/ppusdc-vault-metrics?window=30d',
    '/association-set/root?chainId=11155111',
    '/association-set/leaves?chainId=11155111',
    '/association-set/7/leaves',
    '/labels/rejected?chainId=11155111',
    '/public-key',
    '/11155111/public/event-snapshot/latest',
    '/11155111/public/event-snapshot/payload?include=leaves&sinceBlock=10930000',
    '/global/public/events?page=1&perPage=50&action=deposit',
  ]) {
    test(`allows the real call ${url}`, () => {
      expect(checkAspRequest(get(url))).toEqual({ allowed: true });
    });
  }

  test('allows the entrypoint address, which is public pool configuration', () => {
    const entrypoint = '0xaabbccddeeff00112233445566778899aabbccdd';
    expect(checkAspRequest(get(`/association-set/leaves?chainId=11155111&entrypoint=${entrypoint}`)))
      .toEqual({ allowed: true });
  });

  test('allows the per-asset stats header, which carries a public token address', () => {
    expect(checkAspRequest(get('/11155111/public/asset-statistics', { 'X-Asset': ADDRESS })))
      .toEqual({ allowed: true });
  });

  test('refuses an undeclared query parameter on a declared route', () => {
    const verdict = checkAspRequest(get('/association-set/leaves?chainId=11155111&label=' + LABEL));
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain('undeclared query parameter');
  });

  test('refuses a high-entropy value smuggled through a declared, non-opaque param', () => {
    // `sinceId` is a row cursor. A caller passing a commitment through it is
    // either confused or exfiltrating; either way the ASP must not see it.
    const verdict = checkAspRequest(get(`/11155111/public/yield-deposits?sinceId=${COMMITMENT}`));
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain('high-entropy value');
  });

  test('a block number is not high-entropy, so incremental sync still works', () => {
    expect(looksHighEntropy('10930000')).toBe(false);
    expect(checkAspRequest(get('/11155111/public/event-snapshot/payload?sinceBlock=10930000')))
      .toEqual({ allowed: true });
  });
});

describe('targeted routes need a declared intent', () => {
  test('per-label status is refused on a sync path', () => {
    const verdict = checkAspRequest(get(`/labels/${LABEL}/status?chainId=11155111`));
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain('user-initiated-audit');
  });

  test('per-label status is allowed when the user opened one proof', () => {
    expect(
      checkAspRequest(get(`/labels/${LABEL}/status?chainId=11155111`), 'user-initiated-audit'),
    ).toEqual({ allowed: true });
  });

  test('the wrong intent does not unlock a targeted route', () => {
    const verdict = checkAspRequest(get(`/labels/${LABEL}/status`), 'user-report-address');
    expect(verdict.allowed).toBe(false);
  });

  test('the public feed takes no account filter', () => {
    expect(checkAspRequest(get('/global/public/events?page=1')).allowed).toBe(true);
    expect(checkAspRequest(get(`/global/public/events?address=${ADDRESS}`)).allowed).toBe(false);
  });

  test('the self-report flow is reachable only with its own intent', () => {
    const nonce = get(`/global/public/report-address/nonce?address=${ADDRESS}`);
    expect(checkAspRequest(nonce).allowed).toBe(false);
    expect(checkAspRequest(nonce, 'user-initiated-audit').allowed).toBe(false);
    expect(checkAspRequest(nonce, 'user-report-address').allowed).toBe(true);

    const post: EgressRequest = { method: 'POST', url: '/global/public/report-address', body: '{}' };
    expect(checkAspRequest(post).allowed).toBe(false);
    expect(checkAspRequest(post, 'user-report-address').allowed).toBe(true);
  });

  test('the wallet screening check is reachable only with its own intent', () => {
    const nonce = get(`/global/public/screening/nonce?address=${ADDRESS}`);
    expect(checkAspRequest(nonce).allowed).toBe(false);
    expect(checkAspRequest(nonce, 'user-report-address').allowed).toBe(false);
    expect(checkAspRequest(nonce, 'user-wallet-screening').allowed).toBe(true);

    const body = JSON.stringify({ address: ADDRESS, nonce: 'n', message: 'm', signature: '0x00' });
    const post: EgressRequest = { method: 'POST', url: '/global/public/screening/check', body };
    expect(checkAspRequest(post).allowed).toBe(false);
    expect(checkAspRequest(post, 'user-report-address').allowed).toBe(false);
    expect(checkAspRequest(post, 'user-wallet-screening').allowed).toBe(true);
    // The check carries the SIWE proof and nothing else.
    const extra: EgressRequest = { method: 'POST', url: '/global/public/screening/check', body: '{"labels":["7"]}' };
    expect(checkAspRequest(extra, 'user-wallet-screening').allowed).toBe(false);
    // The self-report's free-text `reason` is not part of this route.
    const withReason: EgressRequest = { method: 'POST', url: '/global/public/screening/check', body: JSON.stringify({ address: ADDRESS, reason: 'x' }) };
    expect(checkAspRequest(withReason, 'user-wallet-screening').allowed).toBe(false);
    const reportWithReason: EgressRequest = { method: 'POST', url: '/global/public/report-address', body: JSON.stringify({ address: ADDRESS, reason: 'x' }) };
    expect(checkAspRequest(reportWithReason, 'user-report-address').allowed).toBe(true);
  });

  test('method is part of the match, so a GET cannot reach a POST-only route', () => {
    expect(checkAspRequest(get('/global/public/report-address'), 'user-report-address').allowed)
      .toBe(false);
  });
});

describe('RPC policy', () => {
  test('allows ordinary wallet and chain traffic', () => {
    expect(checkRpcRequest(rpc({ method: 'eth_chainId', params: [] }))).toEqual({ allowed: true });
    expect(checkRpcRequest(rpc({ method: 'eth_getBalance', params: [ADDRESS, 'latest'] })))
      .toEqual({ allowed: true });
    expect(checkRpcRequest(rpc({ method: 'eth_sendRawTransaction', params: ['0xdeadbeef'] })))
      .toEqual({ allowed: true });
  });

  test('refuses the per-note existence lookup by selector', () => {
    const data = `0x49ce8997${'1'.repeat(64)}`;
    const verdict = checkRpcRequest(rpc({ method: 'eth_call', params: [{ to: ADDRESS, data }, 'latest'] }));
    expect(verdict.allowed).toBe(false);
    expect(verdict.allowed === false && verdict.reason).toContain('names one note');
  });

  test('refuses the per-note spent lookup, including when calldata is in `input`', () => {
    const data = `0x811608fd${'2'.repeat(64)}`;
    expect(checkRpcRequest(rpc({ method: 'eth_call', params: [{ to: ADDRESS, input: data }] })).allowed)
      .toBe(false);
  });

  test('is case-insensitive about the selector', () => {
    const data = `0x49CE8997${'1'.repeat(64)}`;
    expect(checkRpcRequest(rpc({ method: 'eth_call', params: [{ data }] })).allowed).toBe(false);
  });

  test('refuses a forbidden call hidden inside a batch', () => {
    const ok = { method: 'eth_chainId', params: [] };
    const bad = { method: 'eth_call', params: [{ data: `0x811608fd${'3'.repeat(64)}` }] };
    expect(checkRpcRequest(rpc([ok, ok, bad])).allowed).toBe(false);
    expect(checkRpcRequest(rpc([ok, ok])).allowed).toBe(true);
  });

  test('refuses an undeclared method', () => {
    expect(checkRpcRequest(rpc({ method: 'eth_getStorageAt', params: [] })).allowed).toBe(false);
    expect(checkRpcRequest(rpc({ method: 'debug_traceTransaction', params: [] })).allowed).toBe(false);
  });

  test('allows a topic0-only log query and refuses an indexed filter on a note value', () => {
    const sig = `0x${'a'.repeat(64)}`;
    expect(
      checkRpcRequest(rpc({ method: 'eth_getLogs', params: [{ topics: [sig], fromBlock: '0x1' }] }))
        .allowed,
    ).toBe(true);
    expect(
      checkRpcRequest(rpc({ method: 'eth_getLogs', params: [{ topics: [sig, LABEL] }] })).allowed,
    ).toBe(false);
    // A null placeholder in a topic slot filters nothing.
    expect(
      checkRpcRequest(rpc({ method: 'eth_getLogs', params: [{ topics: [sig, null, null] }] })).allowed,
    ).toBe(true);
    // An OR-list of note values is still a filter on note values.
    expect(
      checkRpcRequest(rpc({ method: 'eth_getLogs', params: [{ topics: [sig, [LABEL, LABEL]] }] }))
        .allowed,
    ).toBe(false);
  });

  test('refuses a body it cannot read rather than passing it through', () => {
    expect(checkRpcRequest({ method: 'POST', url: 'https://rpc.example', body: 'not json' }).allowed)
      .toBe(false);
    expect(checkRpcRequest({ method: 'POST', url: 'https://rpc.example', body: null }).allowed)
      .toBe(false);
  });
});

describe('relayer policy', () => {
  test('allows the routes a relayed withdrawal actually uses', () => {
    expect(checkRelayerRequest(get('/v1/details')).allowed).toBe(true);
    expect(checkRelayerRequest({ method: 'POST', url: '/v1/quote/evm/11155111/receive', body: '{}' }).allowed).toBe(true);
    expect(checkRelayerRequest({ method: 'POST', url: '/v1/relay/evm/11155111/withdrawal', body: '{}' }).allowed).toBe(true);
  });

  test('refuses an undeclared relayer route', () => {
    expect(checkRelayerRequest(get('/v1/labels/lookup')).allowed).toBe(false);
  });

  test('refuses a custom header on a relayer call', () => {
    expect(checkRelayerRequest(get('/v1/details', { 'X-Labels': LABEL })).allowed).toBe(false);
  });
});

describe('enforcement', () => {
  // Every assertion below about THROWING has to pin the mode, because the
  // shipped default is `report` (see the test right after this one). A test
  // that inherited the default would quietly stop testing enforcement the
  // moment the default moved, which is exactly what nearly happened here.
  beforeAll(() => setEgressMode('enforce'));

  test('the shipped default is report, not enforce', () => {
    // Read from source: by the time this runs, other tests have set the mode.
    // The behavioural halves are the two tests below; this one pins the
    // DEPLOYED configuration, which no runtime assertion can observe.
    const source = readFileSync(
      join(new URL('.', import.meta.url).pathname, '..', 'egress-policy.ts'),
      'utf8',
    );
    expect(source).toContain(
      "process.env.EXPO_PUBLIC_EGRESS_POLICY === 'enforce' ? 'enforce' : 'report'",
    );
    // And the cost of that default is stated where someone will read it.
    expect(source).toContain('is still sent');
  });

  test('report mode lets the request through; enforce mode fails closed', () => {
    setEgressMode('report');
    expect(() => assertEgressAllowed('asp', get('/nope'))).not.toThrow();
    setEgressMode('enforce');
    expect(getEgressMode()).toBe('enforce');
    expect(() => assertEgressAllowed('asp', get('/nope'))).toThrow('Egress refused');
  });

  test('report mode warns without throwing, and notifies listeners either way', () => {
    const seen: string[] = [];
    const off = onEgressRefusal((party, reason) => seen.push(`${party}:${reason.slice(0, 20)}`));
    try {
      setEgressMode('report');
      expect(() => assertEgressAllowed('asp', get('/nope'))).not.toThrow();
      setEgressMode('enforce');
      expect(() => assertEgressAllowed('asp', get('/nope'))).toThrow();
    } finally {
      setEgressMode('enforce');
      off();
    }
    expect(seen).toHaveLength(2);
    expect(seen[0]?.startsWith('asp:')).toBe(true);
  });

  test('a throwing listener cannot suppress the refusal', () => {
    const off = onEgressRefusal(() => {
      throw new Error('listener blew up');
    });
    try {
      expect(() => assertEgressAllowed('asp', get('/nope'))).toThrow('Egress refused');
    } finally {
      off();
    }
  });

  test('an unknown party is refused rather than waved through', () => {
    expect(() => assertEgressAllowed('sentry' as 'asp', get('/anything'))).toThrow('Egress refused');
  });
});

describe('the allowlist stays honest', () => {
  test('no route names the removed amount-keyed deposit count', () => {
    const amountKeyed = ASP_ROUTES.filter((r) => /larger-than/.test(r.path.source));
    expect(amountKeyed).toEqual([]);
  });

  test('every targeted route declares which intent unlocks it', () => {
    for (const route of ASP_ROUTES) {
      if (route.targeted) {
        expect(route.intents?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  test('a route cannot mark a param both opaque and targeted', () => {
    for (const route of ASP_ROUTES) {
      const opaque = new Set(route.opaqueParams ?? []);
      for (const t of Object.keys(route.targetedParams ?? {})) expect(opaque.has(t)).toBe(false);
    }
  });

  test('every declared param name is actually listed in params', () => {
    for (const route of ASP_ROUTES) {
      const declared = new Set(route.params ?? []);
      for (const p of [...(route.opaqueParams ?? []), ...(Object.keys(route.targetedParams ?? {}))]) {
        expect(declared.has(p)).toBe(true);
      }
    }
  });
});


describe('review regressions: fail closed without leaking refusals', () => {
  for (const body of [null, [], [null], [1], [true], [[], { method: 'eth_chainId' }], { method: 'eth_call', params: {} }]) {
    test(`malformed RPC envelope ${JSON.stringify(body)}`, () => {
      expect(checkRpcRequest(rpc(body)).allowed).toBe(false);
    });
  }

  test('GET without a JSON-RPC body is refused too', () => {
    expect(checkRpcRequest(get('https://rpc.example/?label=' + LABEL)).allowed).toBe(false);
  });

  test('RPC checks headers and both calldata aliases, including gas estimation', () => {
    const data = `0x811608fd${'2'.repeat(64)}`;
    for (const method of ['eth_call', 'eth_estimateGas', 'eth_fillTransaction']) {
      expect(checkRpcRequest(rpc({ method, params: [{ data: '0x', input: data }] })).allowed).toBe(false);
    }
    expect(checkRpcRequest({ ...rpc({ method: 'eth_chainId' }), headers: { 'X-Labels': LABEL } }).allowed).toBe(false);
  });

  test('aggregate3 admits token reads but refuses nested note reads', () => {
    const aggregate = (data: `0x${string}`) => encodeFunctionData({
      abi: multicall3Abi, functionName: 'aggregate3', args: [[{ target: ADDRESS, allowFailure: true, callData: data }]],
    });
    const check = (data: string) => checkRpcRequest(rpc({ method: 'eth_call', params: [{ to: ADDRESS, data }, 'latest'] })).allowed;
    expect(check(aggregate(`0x70a08231${'0'.repeat(24)}${ADDRESS.slice(2)}`))).toBe(true);
    expect(check(aggregate(`0x811608fd${'2'.repeat(64)}`))).toBe(false);
    expect(check(aggregate(aggregate(`0x811608fd${'2'.repeat(64)}`)))).toBe(false);
    expect(check('0x82ad56cb')).toBe(false);
  });

  test('block replacement detection includes full transactions and local wallets can fill transactions', () => {
    expect(checkRpcRequest(rpc({ method: 'eth_getBlockByNumber', params: ['latest', true] })).allowed).toBe(true);
    expect(checkRpcRequest(rpc({ method: 'eth_fillTransaction', params: [{ from: ADDRESS, to: ADDRESS }] })).allowed).toBe(true);
  });

  test('an indexed address is deliberately still a targeted filter, including padded ERC20 owners', () => {
    for (const owner of [ADDRESS, `0x${'0'.repeat(24)}${ADDRESS.slice(2)}`]) {
      expect(checkRpcRequest(rpc({ method: 'eth_getLogs', params: [{ topics: [`0x${'a'.repeat(64)}`, owner] }] })).allowed).toBe(false);
    }
  });

  test('header values, duplicate params, bodies and short or encoded query payloads are checked', () => {
    for (const headers of [{ accept: LABEL }, { 'content-type': 'application/json; label=7' }, { 'accept-language': 'en-US' }]) {
      expect(checkAspRequest(get('/public-key', headers)).allowed).toBe(false);
    }
    for (const query of ['window=1000000', 'window=abc', 'window=bGFiZWw=', 'sinceId=bGFiZWw=', 'sinceId=1&sinceId=2']) {
      const path = query.startsWith('window') ? 'ppusdc-vault-metrics' : 'yield-deposits';
      expect(checkAspRequest(get(`/1/public/${path}?${query}`)).allowed).toBe(false);
    }
    expect(checkAspRequest({ ...get('/public-key'), body: JSON.stringify({ labels: [LABEL] }) }).allowed).toBe(false);
    expect(checkAspRequest({ method: 'POST', url: '/global/public/report-address', body: '{"labels":["7"]}' }, 'user-report-address').allowed).toBe(false);
    // A small amount is indistinguishable from a valid numeric cursor. This
    // heuristic is defense in depth, not information-flow tracking.
    expect(looksHighEntropy('1000000')).toBe(false);
    expect(looksHighEntropy('bGFiZWw=')).toBe(false);
  });

  test('relayer methods, query keys and body fields are declared exactly', () => {
    // `/fees` and `/status/{hash}` used to be declared here. They are not in
    // the vendored SDK and nothing in this app calls them, so they are gone:
    // an allowlist entry for a route nobody builds is a standing exemption
    // with no caller to justify it. See egress-policy-coverage.test.ts, which
    // derives the real inventory from node_modules.
    expect(checkRelayerRequest(get('/fees')).allowed).toBe(false);
    expect(checkRelayerRequest(get(`/status/0x${'1'.repeat(64)}`)).allowed).toBe(false);
    expect(checkRelayerRequest(get('/v1/details?label=7')).allowed).toBe(false);
    expect(checkRelayerRequest({ method: 'POST', url: '/v1/details' }).allowed).toBe(false);
    expect(checkRelayerRequest(get('/v1/quote/evm/1/receive')).allowed).toBe(false);
    expect(checkRelayerRequest({ method: 'POST', url: '/v1/quote/evm/1/made-up', body: '{}' }).allowed).toBe(false);
    expect(checkRelayerRequest({ method: 'POST', url: '/v1/quote/evm/1/transfer', body: '{"labels":["7"]}' }).allowed).toBe(false);
  });

  test('an intent cannot unlock a different route or targeted param', () => {
    expect(checkAspRequest(get(`/global/public/events?address=${ADDRESS}`), 'user-initiated-audit').allowed).toBe(false);
    expect(checkAspRequest(get(`/labels/${LABEL}/status?address=${ADDRESS}`), 'user-initiated-audit').allowed).toBe(false);
    for (const route of ASP_ROUTES) {
      for (const intents of Object.values(route.targetedParams ?? {})) expect(intents.length).toBeGreaterThan(0);
    }
  });

  test('errors and listeners never retain dynamic paths, unknown keys or method values', () => {
    const seen: string[] = [];
    const off = onEgressRefusal((_party, reason) => seen.push(reason));
    try {
      for (const [party, req] of [
        ['asp', get(`/labels/${LABEL}/status`)],
        ['asp', get(`/unknown/${LABEL}?${LABEL}=7`)],
        ['asp', get(`/public-key?${LABEL}=7`)],
        ['asp', get('/public-key', { [LABEL]: '7' })],
        ['relayer', get(`/status/${LABEL}`)],
        ['rpc', rpc({ method: LABEL })],
      ] as const) {
        let error: unknown;
        try { assertEgressAllowed(party, req); } catch (e) { error = e; }
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).not.toContain(LABEL);
        expect(JSON.stringify(error)).not.toContain(LABEL);
      }
    } finally { off(); }
    expect(seen.length).toBe(6);
    expect(seen.join()).not.toContain(LABEL);
  });
});
