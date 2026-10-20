import { describe, expect, test } from 'bun:test';

import {
  WAIVERS,
  reportJourneyPrivacy,
  pollBudgetsFrom,
  resolveHosts,
  runNetworkPrivacyGate,
  timingViolationsFor,
  type TimingWindow,
  type Waiver,
} from '../../scripts/e2e/privacy-gate';
import { classifyDestination, type CapturedRequest } from '../../scripts/e2e/network-privacy';

const HOSTS = resolveHosts({
  aspUrl: 'https://api-dev.0xbow.io',
  rpcUrl: 'https://eth-sepolia.g.alchemy.com/v2/key',
  ownOrigin: 'http://localhost:8081',
});

const req = (over: Partial<CapturedRequest> & { url: string; t: number }): CapturedRequest => ({
  method: 'GET',
  headers: {},
  body: null,
  kind: 'http',
  ...over,
});

const LABEL = '0x2f1a4c9d1b7e6a5038f2c4d9e8b7a6150c3d2e1f0a9b8c7d6e5f4031223344556';
const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const AMOUNT_WEI = '200000000000000';

describe('host resolution', () => {
  test('configured fallback RPCs retain content checks and do not trust sibling hosts', () => {
    const hosts = resolveHosts({ rpcUrls: ['https://rpc.example.test/path'] });
    expect(classifyDestination('https://rpc.example.test/path', hosts)).toBe('rpc');
    expect(classifyDestination('https://other.rpc.example.test/path', hosts)).toBe('other');
    const report = runNetworkPrivacyGate({
      captured: [req({ url: `https://rpc.example.test/?amount=${AMOUNT_WEI}`, t: 2 })],
      secrets: { amountsWei: [AMOUNT_WEI] }, hosts,
    });
    expect(report.ok).toBe(false);
  });
  test('classifies the four parties we actually talk to', () => {
    expect(classifyDestination('https://api-dev.0xbow.io/public-key', HOSTS)).toBe('asp');
    expect(classifyDestination('https://eth-sepolia.g.alchemy.com/v2/k', HOSTS)).toBe('rpc');
    expect(
      classifyDestination(
        'https://relayer-staging.example/v1/details',
        HOSTS,
      ),
    ).toBe('relayer');
    expect(classifyDestination('http://localhost:8081/index.bundle', HOSTS)).toBe('own-origin');
    expect(classifyDestination('ws://localhost:8081/hot', HOSTS)).toBe('own-origin');
    expect(classifyDestination('ws://localhost:8082/hot', HOSTS)).toBe('other');
    expect(classifyDestination('wss://localhost:8081/hot', HOSTS)).toBe('other');
  });

  test('the relayer is named by hostname, not by prefix', () => {
    // A configured PREFIX like 'relayer-v2-' matches no hostname at all under
    // the engine's DNS-label rules, so the relayer would silently become an
    // unknown third party and every correct relayed withdrawal would fail the
    // gate. This is the regression for that.
    expect(HOSTS.relayer.every((h) => h.includes('.'))).toBe(true);
    for (const host of HOSTS.relayer) {
      expect(classifyDestination(`https://${host}/v1/details`, HOSTS)).toBe('relayer');
    }
  });

  test('a lookalike host is not our origin', () => {
    expect(classifyDestination('http://localhost.evil.test:8081/x', HOSTS)).toBe('other');
    expect(classifyDestination('https://api-dev.0xbow.io.evil.test/x', HOSTS)).toBe('other');
  });

  test('the error reporter is a third party like any other', () => {
    // Sentry is deliberately NOT added to the host map. `other` is the
    // strictest class the engine has, so a secret that reached a Sentry
    // envelope fails a journey run the same way one sent to a stranger
    // would. Whitelisting the ingest host would exempt exactly the payload
    // that leaked in the 2026-09-10 disclosure.
    expect(classifyDestination('https://o4509437312958464.ingest.us.sentry.io/api/1/envelope/', HOSTS)).toBe('other');
    const leak = req({
      url: 'https://o4509437312958464.ingest.us.sentry.io/api/1/envelope/',
      method: 'POST',
      body: JSON.stringify({ contexts: { withdrawal: { label: LABEL } } }),
      t: 2,
    });
    const report = runNetworkPrivacyGate({ captured: [leak], secrets: { labels: [LABEL] }, hosts: HOSTS });
    expect(report.ok).toBe(false);
    expect(report.detail).toContain('1 leak(s)');
  });
});

describe('poll budgets from measured idle windows', () => {
  const shape = (t: number) => req({ url: 'https://api-dev.0xbow.io/global/public/events', t });

  test('the busiest control wins, plus one call of headroom', () => {
    // Window A saw the poll once, window B twice: a 30s poll in a 20s window
    // does exactly this depending only on phase. The budget must survive the
    // worse case or the gate fails on a quiet app.
    const budgets = pollBudgetsFrom([[shape(1)], [shape(2), shape(3)]]);
    expect(budgets).toHaveLength(1);
    expect(budgets[0]!.maxRequests).toBe(3);
  });

  test('budgets are keyed on the whole request shape, not the URL', () => {
    const a = req({ url: 'https://api-dev.0xbow.io/x', t: 1, method: 'GET' });
    const b = req({ url: 'https://api-dev.0xbow.io/x', t: 2, method: 'POST', body: '{}' });
    expect(pollBudgetsFrom([[a, b]])).toHaveLength(2);
  });

  test('an empty baseline grants nothing', () => {
    expect(pollBudgetsFrom([[], []])).toEqual([]);
  });
});

describe('timing: a request that only happens when the form opens', () => {
  const window: TimingWindow = {
    action: 'open the withdraw form and type an amount',
    baselines: [
      { start: 0, end: 100 },
      { start: 100, end: 200 },
    ],
    start: 200,
    end: 300,
  };
  const poll = (t: number) => req({ url: 'https://api-dev.0xbow.io/global/public/events', t });

  test('a background poll seen in the controls is not a violation', () => {
    const captured = [poll(10), poll(110), poll(210)];
    expect(timingViolationsFor(captured, window, HOSTS)).toEqual([]);
  });

  test('an endpoint never seen before the form opened IS a violation', () => {
    // The exact shape of the disclosed leak: an ASP route that is only ever
    // touched once a withdrawal is imminent. No amount of background polling
    // explains it, and no substring allowlist would have caught it.
    const leak = req({
      url: `https://api-dev.0xbow.io/global/public/deposits-larger-than?amount=${AMOUNT_WEI}`,
      t: 250,
    });
    const violations = timingViolationsFor([poll(10), poll(110), leak], window, HOSTS);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.detail).toContain('deposits-larger-than');
  });

  test('expired CORS permissions require a matching budgeted poll, not an OPTIONS exemption', () => {
    const preflight = (over: Partial<CapturedRequest> = {}) => req({
      url: poll(0).url, t: 209, method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'GET' }, ...over,
    });
    const baseline = [poll(10), poll(110)];
    const captured = [...baseline, preflight(), poll(210)];
    expect(timingViolationsFor(captured, window, HOSTS)).toEqual([]);
    expect(timingViolationsFor([...baseline, preflight()], window, HOSTS)).toHaveLength(1);
    expect(timingViolationsFor([...captured, preflight({ t: 220 })], window, HOSTS)).toHaveLength(1);
    const changes: Partial<CapturedRequest>[] = [
      { url: `${poll(0).url}?amount=${AMOUNT_WEI}` },
      { headers: { 'access-control-request-method': 'POST' } },
      { headers: {} }, { body: LABEL },
    ];
    for (const changed of changes) {
      expect(timingViolationsFor([...baseline, preflight(changed), poll(210)], window, HOSTS)).toHaveLength(1);
    }
    const leak = preflight({ headers: { 'access-control-request-method': 'GET', 'access-control-request-headers': `x-${LABEL}` } });
    const report = runNetworkPrivacyGate({ captured: [...baseline, leak, poll(210)], secrets: { labels: [LABEL] }, hosts: HOSTS, windows: [window] });
    expect(report.detail).toContain('1 leak(s)');
    expect(report.ok).toBe(false);
  });

  test('own-origin dev traffic is not a third party and never violates', () => {
    const bundle = req({ url: 'http://localhost:8081/index.bundle?platform=web', t: 250 });
    expect(timingViolationsFor([bundle], window, HOSTS)).toEqual([]);
  });

  test('headroom is bounded: a burst well past the measured rate still fails', () => {
    const captured = [poll(10), poll(110), poll(210), poll(220), poll(230), poll(240)];
    expect(timingViolationsFor(captured, window, HOSTS).length).toBeGreaterThan(0);
  });
});

describe('the gate verdict', () => {
  const hosts = HOSTS;
  // A known gap, to exercise the waiver mechanics without depending on which
  // debts the real list carries today.
  const gap: Waiver = {
    url: /\/global\/public\/statistics\?who=/,
    kind: 'addresses',
    destination: 'asp',
    reason: 'test',
  };
  const waivedRequest = req({
    url: `https://api-dev.0xbow.io/global/public/statistics?who=${ADDRESS}`,
    t: 1,
  });

  test('a known gap is reported and waived, not failed', () => {
    const report = runNetworkPrivacyGate({
      captured: [waivedRequest],
      secrets: { addresses: [ADDRESS] },
      hosts,
      waivers: [gap],
    });
    expect(report.ok).toBe(true);
    expect(report.text).toContain('WAIVED');
    expect(report.detail).toContain('1 waived');
  });

  test('an unused waiver fails the run, so a closed gap cannot keep its exemption', () => {
    const report = runNetworkPrivacyGate({ captured: [], secrets: {}, hosts, waivers: [gap] });
    expect(report.ok).toBe(false);
    expect(report.text).toContain('STALE WAIVER');
  });

  test('a real leak fails even while a waiver is in force', () => {
    const leak = req({
      url: 'https://api-dev.0xbow.io/global/public/statistics',
      t: 2,
      headers: { 'x-labels': LABEL },
    });
    const report = runNetworkPrivacyGate({
      captured: [waivedRequest, leak],
      secrets: { addresses: [ADDRESS], labels: [LABEL] },
      hosts,
      waivers: [gap],
    });
    expect(report.ok).toBe(false);
    expect(report.detail).toContain('1 leak(s)');
  });

  test('submission permits only fresh outputs in their proof slots, keeping every other location private', () => {
    const output = '0x' + 'ab'.repeat(32);
    const input = '0x' + 'cd'.repeat(32);
    const txHash = '0x' + 'ef'.repeat(32);
    const body = { inputNullifierNumber: 1, outputCommitmentNumber: 1, proof: { publicSignals: ['0x1', output] } };
    const relay = req({ method: 'POST', t: 2,
      url: 'https://testnet-relayer.privacypools.com/v1/relay/evm/11155111/withdrawal',
      body: JSON.stringify(body) });
    const check = (request: CapturedRequest, submittedCommitments = [output]) => runNetworkPrivacyGate({
      captured: [request], hosts, submittedCommitments,
      secrets: { addresses: [ADDRESS], commitments: [input, output, txHash] },
    }).ok;
    expect(check(relay)).toBe(true);
    expect(check(relay, [])).toBe(false); // Preparation has no disclosure permission.
    for (const leaked of [
      { ...relay, headers: { 'x-output': output } },
      { ...relay, body: JSON.stringify({ ...body, extra: output }) },
      { ...relay, body: JSON.stringify({ ...body, proof: { publicSignals: [input, output] } }) },
      { ...relay, url: relay.url.replace('/relay/', '/quote/') },
      { ...relay, url: 'https://ethereum-sepolia-rpc.publicnode.com', body: JSON.stringify({ method: 'eth_getTransactionReceipt', params: [txHash] }) },
    ]) expect(check(leaked)).toBe(false);
    expect(JSON.parse(relay.body!).proof.publicSignals[1]).toBe(output); // Keep the captured evidence intact.
  });

  test('every waiver names what clears it', () => {
    for (const w of WAIVERS) {
      expect(w.reason.length).toBeGreaterThan(60);
      expect(w.reason).toContain('egress-policy.ts');
    }
  });

  test('a staging failure report to Sentry is waived, and its absence is not a stale waiver', () => {
    // 2026-09-18: the e2e withdraw step failed on a relayer fetch, the staging
    // build reported it with the designed diagnostic block (address, amount,
    // raw error), and the gate failed the run a second time for that envelope.
    // Only the Sentry ingest envelope is waived; the same body anywhere else fails.
    const envelope = req({
      method: 'POST', t: 2,
      url: 'https://o4509437312958464.ingest.us.sentry.io/api/4512068713840640/envelope/?sentry_version=7',
      body: JSON.stringify({ contexts: { diagnostic: { address: ADDRESS, amount: '0.0002', detail: 'RelayerRejected: Failed to fetch' } } }),
    });
    const withEnvelope = runNetworkPrivacyGate({ captured: [envelope], secrets: { addresses: [ADDRESS] }, hosts });
    expect(withEnvelope.ok).toBe(true);
    expect(withEnvelope.detail).toContain('1 waived');
    expect(withEnvelope.text).toContain('WAIVED other addresses');
    // A green run never sends the envelope: that must not read as a rotten waiver.
    const without = runNetworkPrivacyGate({ captured: [], secrets: { addresses: [ADDRESS] }, hosts });
    expect(without.ok).toBe(true);
    expect(without.detail).toContain('0 stale waiver(s)');
    // Another third party carrying the same body is still a leak.
    const elsewhere = { ...envelope, url: 'https://example-analytics.invalid/collect' };
    expect(runNetworkPrivacyGate({ captured: [elsewhere], secrets: { addresses: [ADDRESS] }, hosts }).ok).toBe(false);
  });
});

describe('the end-of-run verdict is fail-safe', () => {
  // A fake page: collectJourneySecrets only needs `evaluate` to hand back the
  // harvest shape. The real page.evaluate is covered by the browser smoke
  // check (scripts/e2e/privacy-gate-smoke.mjs); these cover the wiring that
  // sits in a @ts-nocheck file and would otherwise never be checked at all.
  const page = {
    evaluate: async () => ({
      labels: [LABEL],
      commitments: [],
      nullifiers: [],
      amountsWei: [],
    }),
  } as unknown as Parameters<typeof reportJourneyPrivacy>[0]['page'];

  // The one waiver the real list carries: a staging failure report.
  const waived = req({
    method: 'POST',
    url: 'https://o4509437312958464.ingest.us.sentry.io/api/4512068713840640/envelope/?sentry_version=7',
    body: JSON.stringify({ contexts: { diagnostic: { address: ADDRESS } } }),
    t: 1,
  });
  const base = {
    page,
    captured: [waived],
    addresses: [ADDRESS],
    aspUrl: 'https://api-dev.0xbow.io',
    ownOrigin: 'http://localhost:8081',
  };
  const window: TimingWindow = {
    action: 'x',
    baselines: [{ start: 0, end: 10 }, { start: 10, end: 20 }],
    start: 20,
    end: 30,
  };

  test('a run that measured no window FAILS: passing on zero evidence is the bug', async () => {
    const report = await reportJourneyPrivacy({ ...base, flush: async () => {}, windows: [] });
    expect(report.ok).toBe(false);
    expect(report.detail).toContain('nothing was proven');
  });

  test('a flush that throws FAILS rather than reporting clean', async () => {
    // flushCapture throws when the browser omitted bytes it should have given
    // us. An incomplete observation must never read as "no leaks found".
    const report = await reportJourneyPrivacy({
      ...base,
      flush: async () => { throw new Error('Incomplete network capture: body bytes missing'); },
      windows: [window],
    });
    expect(report.ok).toBe(false);
    expect(report.detail).toContain('gate could not run');
    expect(report.detail).toContain('Incomplete network capture');
  });

  test('a measured window with only waived traffic passes', async () => {
    const report = await reportJourneyPrivacy({ ...base, flush: async () => {}, windows: [window] });
    expect(report.ok).toBe(true);
    expect(report.text).toContain('WAIVED');
  });

  test('the typed withdrawal amount is private even when no stored note has that value', async () => {
    const report = await reportJourneyPrivacy({
      ...base, flush: async () => {}, windows: [window], amountsWei: ['200000000000000'],
      captured: [req({ url: 'https://api-dev.0xbow.io/?amount=200000000000000', t: 2 })],
    });
    expect(report.ok).toBe(false);
    expect(report.detail).toContain('1 leak(s)');
  });

  test('the harvest reaches the verdict: a harvested label leaking is caught', async () => {
    const leak = req({
      url: 'https://api-dev.0xbow.io/global/public/statistics',
      t: 2,
      headers: { 'x-labels': LABEL },
    });
    const report = await reportJourneyPrivacy({
      ...base,
      captured: [waived, leak],
      flush: async () => {},
      windows: [window],
    });
    expect(report.ok).toBe(false);
    // ONE finding, not two. The harvest declares a label once; declaring the
    // same value as both `labels` and `labelHashes` reported every label leak
    // twice, and an inflated count is how a gate starts being discounted.
    expect(report.detail).toContain('1 leak(s)');
  });
});


test('RPC polls tolerate correlation IDs while enforcing method, params, and cadence', () => {
  const rpc = (id: number, params = ['latest', false], method = 'eth_getBlockByNumber') => req({
    url: 'https://ethereum-sepolia-rpc.publicnode.com', t: id * 10,
    method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const window = { action: 'form', baselines: [{ start: 0, end: 20 }, { start: 20, end: 40 }], start: 40, end: 80 };
  const baseline = [rpc(1), rpc(3)];
  expect(timingViolationsFor([...baseline, rpc(5)], window, HOSTS)).toEqual([]);
  expect(timingViolationsFor([...baseline, rpc(5, ['pending', false])], window, HOSTS)).toHaveLength(1);
  expect(timingViolationsFor([...baseline, rpc(5, [], 'eth_gasPrice')], window, HOSTS)).toHaveLength(1);
  expect(timingViolationsFor([...baseline, rpc(5), rpc(6), rpc(7)], window, HOSTS)).toHaveLength(1);
});
