import { describe, expect, test } from 'bun:test';
import { gzipSync, deflateSync, deflateRawSync, brotliCompressSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  classifyDestination,
  describeLeaks,
  encodingsOf,
  findLeaks,
  findTimingViolations,
  type CapturedRequest,
  type DestinationHosts,
  type AlwaysOnPollMatcher,
  type JourneySecrets,
  type PollBudget,
} from '../../scripts/e2e/network-privacy';

const HOSTS: DestinationHosts = {
  asp: ['api.0xbow.io', 'api-dev.0xbow.io'],
  rpc: ['alchemy.com', 'infura.io'],
  relayer: ['relayer.0xbow.io'],
  ownOrigin: ['privacypools.com'],
};

const LABEL = '12345678901234567890123456789012345678901234567890';
const AMOUNT = '2500000000000000000';

const req = (over: Partial<CapturedRequest>): CapturedRequest => ({
  t: 1000,
  method: 'GET',
  url: 'https://api.0xbow.io/1/public/mt-leaves',
  headers: {},
  body: null,
  kind: 'http',
  ...over,
});

describe('encodingsOf', () => {
  test('covers decimal, hex, padded and url-encoded forms of one value', () => {
    // The whole point: the same label goes out as decimal to one endpoint and
    // 0x-hex to another, so checking one form silently passes.
    const forms = encodingsOf(AMOUNT);
    expect(forms).toContain('2500000000000000000');
    expect(forms).toContain('0x22b1c8c1227a0000');
    expect(forms.some((f) => f.startsWith('0x0000'))).toBe(true);
  });

  test('drops values too short to match without false positives', () => {
    // '1' or a chain id would match nearly every request body.
    expect(encodingsOf('1')).toEqual([]);
    expect(encodingsOf('11155111')).toEqual([]);
  });

  test('returns nothing for empty input rather than matching everything', () => {
    expect(encodingsOf('')).toEqual([]);
    expect(encodingsOf('   ')).toEqual([]);
  });
});

describe('classifyDestination', () => {
  test('classifies by host so a policy binds to a party, not a path', () => {
    expect(classifyDestination('https://api.0xbow.io/1/public/x', HOSTS)).toBe('asp');
    expect(classifyDestination('https://eth-mainnet.g.alchemy.com/v2/k', HOSTS)).toBe('rpc');
    expect(classifyDestination('https://relayer.0xbow.io/v1/quote', HOSTS)).toBe('relayer');
  });

  test('treats an unrecognised host as hostile rather than as fine', () => {
    expect(classifyDestination('https://errors.example.com/x', HOSTS)).toBe('other');
    expect(classifyDestination('not a url', HOSTS)).toBe('other');
  });
});

describe('findLeaks', () => {
  test('catches the amount leak in a query string', () => {
    // The 2026-09-10 bug, exactly: deposits-larger-than?amount=<wei> to the ASP.
    const leaks = findLeaks(
      [req({ url: `https://api.0xbow.io/1/public/deposits-larger-than?amount=${AMOUNT}` })],
      { amountsWei: [AMOUNT] },
      HOSTS,
    );
    expect(leaks).toHaveLength(1);
    expect(leaks[0].where).toBe('url');
    expect(leaks[0].destination).toBe('asp');
  });

  test('catches a label leak that travels in a HEADER', () => {
    // The other half of the same disclosure. A URL-only check misses this.
    const leaks = findLeaks(
      [req({ url: 'https://api.0xbow.io/1/public/deposits-by-label', headers: { 'X-Labels': LABEL } })],
      { labels: [LABEL] },
      HOSTS,
    );
    expect(leaks).toHaveLength(1);
    expect(leaks[0].where).toBe('header');
  });

  test('catches a value sent in one encoding when the secret is held in another', () => {
    const hex = `0x${BigInt(AMOUNT).toString(16)}`;
    const leaks = findLeaks([req({ url: `https://api.0xbow.io/x?a=${hex}` })], { amountsWei: [AMOUNT] }, HOSTS);
    expect(leaks).toHaveLength(1);
    expect(leaks[0].encoding).toBe(hex);
  });

  test('allows the relayer the amount and recipient it needs to build the withdrawal', () => {
    // A gate that fails on correct behaviour gets switched off, so the policy
    // is per-destination rather than a blanket ban.
    const leaks = findLeaks(
      [req({ method: 'POST', url: 'https://relayer.0xbow.io/v1/request', body: `{"amount":"${AMOUNT}"}` })],
      { amountsWei: [AMOUNT] },
      HOSTS,
    );
    expect(leaks).toEqual([]);
  });

  test('still forbids the relayer a note identifier', () => {
    const leaks = findLeaks(
      [req({ method: 'POST', url: 'https://relayer.0xbow.io/v1/request', body: `{"label":"${LABEL}"}` })],
      { labels: [LABEL] },
      HOSTS,
    );
    expect(leaks).toHaveLength(1);
  });

  test('allows an RPC an address but never a note value', () => {
    const addr = '0x1234567890abcdef1234567890abcdef12345678';
    expect(
      findLeaks([req({ url: `https://eth-mainnet.g.alchemy.com/v2/k?a=${addr}` })], { addresses: [addr] }, HOSTS),
    ).toEqual([]);
    expect(
      findLeaks([req({ url: `https://eth-mainnet.g.alchemy.com/v2/k?c=${LABEL}` })], { commitments: [LABEL] }, HOSTS),
    ).toHaveLength(1);
  });

  test('passes a clean caller-independent request', () => {
    const leaks = findLeaks(
      [req({ url: 'https://api.0xbow.io/1/public/deposit-amounts' })],
      { labels: [LABEL], amountsWei: [AMOUNT] },
      HOSTS,
    );
    expect(leaks).toEqual([]);
  });

  test('names the party, the value and where it travelled', () => {
    const leaks = findLeaks(
      [req({ url: `https://api.0xbow.io/x?amount=${AMOUNT}` })],
      { amountsWei: [AMOUNT] },
      HOSTS,
    );
    const text = describeLeaks(leaks);
    expect(text).toContain('ASP');
    expect(text).toContain(AMOUNT);
    expect(text).toContain('url');
  });
});

describe('findTimingViolations', () => {
  const polls: AlwaysOnPollMatcher = [{ url: 'https://api.0xbow.io/1/public/deposit-amounts', method: 'GET', kind: 'http', body: null, maxRequests: 1 }];

  test('flags a request that fired only because the form was opened', () => {
    // Body says nothing about the caller; its existence at this moment does.
    const violations = findTimingViolations(
      [req({ t: 500, url: 'https://api.0xbow.io/1/public/association-set/root' }), req({ t: 1500, url: 'https://api.0xbow.io/1/public/something-on-open' })],
      1000,
      2000,
      polls,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].detail).toContain('something-on-open');
  });

  test('accepts background polls that run regardless of what the user does', () => {
    const violations = findTimingViolations(
      [req({ t: 1200, url: 'https://api.0xbow.io/1/public/deposit-amounts' })],
      1000,
      2000,
      polls,
    );
    expect(violations).toEqual([]);
  });

  test('ignores traffic outside the observation window', () => {
    const violations = findTimingViolations([req({ t: 5000, url: 'https://api.0xbow.io/x' })], 1000, 2000, polls);
    expect(violations).toEqual([]);
  });
});


describe('wire regression cases', () => {
  const hex = BigInt(LABEL).toString(16).padStart(64, '0');
  const escaped = [...LABEL].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const multipart = (parts: string[]) => parts.map((part, i) => `--boundary\r\nContent-Disposition: form-data; name="part${i}"\r\n\r\n${part}\r\n`).join('') + '--boundary--\r\n';
  const cases: [string, Partial<CapturedRequest>][] = [
    ['path', { url: `https://api.0xbow.io/labels/${LABEL}/status` }],
    ['all percent escaped digits', { url: `https://api.0xbow.io/x?a=${[...LABEL].map((c) => `%${c.charCodeAt(0).toString(16)}`).join('')}` }],
    ['double URL encoding', { body: encodeURIComponent(encodeURIComponent(`{"label":"${LABEL}"}`)) }],
    ['JSON unicode escapes', { body: `{"label":"${escaped}"}` }],
    ['JSON string inside JSON string', { body: JSON.stringify({ payload: JSON.stringify({ label: escaped }).replaceAll('\\\\u', '\\u') }) }],
    ['text base64', { body: Buffer.from(LABEL).toString('base64') }],
    ['text base64url unpadded', { body: Buffer.from(LABEL).toString('base64url') }],
    ['base64 JSON envelope', { body: JSON.stringify({ data: Buffer.from(JSON.stringify({ label: LABEL })).toString('base64') }) }],
    ['base64url JSON envelope', { body: Buffer.from(JSON.stringify({ label: LABEL, tag: '???' })).toString('base64url') }],
    ['base64 ABI bytes', { body: Buffer.from(hex, 'hex').toString('base64') }],
    ['base64url ABI bytes', { body: Buffer.from(hex, 'hex').toString('base64url') }],
    ['raw ABI bytes', { bodyBase64: Buffer.from(hex, 'hex').toString('base64') }],
    ['split query', { url: `https://api.0xbow.io/x?a=${LABEL.slice(0, 20)}&b=${LABEL.slice(20)}` }],
    ['split form', { body: `a=${LABEL.slice(0, 20)}&b=${LABEL.slice(20)}` }],
    ['split JSON array', { body: JSON.stringify([LABEL.slice(0, 20), LABEL.slice(20)]) }],
    ['multipart field', { body: multipart([LABEL]) }],
    ['split multipart fields', { body: multipart([LABEL.slice(0, 20), LABEL.slice(20)]) }],
    ['binary websocket', { kind: 'websocket', method: 'WS', url: 'wss://api.0xbow.io/ws', bodyBase64: Buffer.from(hex, 'hex').toString('base64') }],
    ['cookie', { headers: { cookie: `labels=${LABEL}` } }],
  ];
  for (const [name, request] of cases) test(`detects ${name}`, () => {
    const leaks = findLeaks([req(request)], { labels: [LABEL] }, HOSTS);
    expect(leaks).toHaveLength(1);
    expect(leaks[0].kind).toBe('labels');
  });

  for (const [encoding, compress] of [
    ['gzip', gzipSync], ['deflate', deflateSync], ['deflate', deflateRawSync], ['br', brotliCompressSync],
  ] as const) test(`decodes ${encoding} body bytes`, () => {
    const bodyBase64 = compress(Buffer.from(JSON.stringify({ label: LABEL }))).toString('base64');
    const leaks = findLeaks([req({ headers: { 'Content-Encoding': encoding }, bodyBase64 })], { labels: [LABEL] }, HOSTS);
    expect(leaks).toHaveLength(1);
    expect(leaks[0].where).toBe('body');
  });

  test('rejects unreadable capture or compressed bytes instead of reporting clean', () => {
    expect(() => findLeaks([req({ captureError: 'file bytes omitted' })], {}, HOSTS)).toThrow('Incomplete network capture');
    expect(() => findLeaks([req({ headers: { 'content-encoding': 'gzip' }, body: 'bad' })], {}, HOSTS)).toThrow();
    expect(() => findLeaks([req({ headers: { 'content-encoding': 'unknown' } })], {}, HOSTS)).toThrow('Unsupported');
  });

  test('fails closed when decoding exceeds its budget', () => {
    const bodyBase64 = gzipSync(Buffer.alloc(9 * 1024 * 1024, 65)).toString('base64');
    expect(() => findLeaks([req({ bodyBase64, headers: { 'content-encoding': 'gzip' } })], {}, HOSTS)).toThrow();
    let body = LABEL;
    for (let i = 0; i < 15; i++) body = JSON.stringify(body);
    expect(() => findLeaks([req({ body })], { labels: [LABEL] }, HOSTS)).toThrow('decode budget');
  });

  test('handles checksummed addresses and low numeric-value 20-byte addresses', () => {
    const address = '0x52908400098527886E0F7030069857D2E4169EE7';
    expect(findLeaks([req({ body: address })], { addresses: [address.toLowerCase()] }, HOSTS)).toHaveLength(1);
    const small = '0x000000000000000000000000000000000000dead';
    expect(findLeaks([req({ body: small })], { addresses: [small] }, HOSTS)).toHaveLength(1);
    expect(findLeaks([req({ body: '57005 or 0xdead' })], { addresses: [small] }, HOSTS)).toEqual([]);
  });

  test('keeps arbitrary strings and base64 case-sensitive', () => {
    const label = 'Private-Label-That-Is-Not-A-Number';
    expect(findLeaks([req({ body: label.toLowerCase() })], { labels: [label] }, HOSTS)).toEqual([]);
    const changedCase = Buffer.from(LABEL).toString('base64').toLowerCase();
    expect(findLeaks([req({ body: changedCase })], { labels: [LABEL] }, HOSTS)).toEqual([]);
  });

  test('does not count untransmitted URL fragments or benign third-party resources', () => {
    expect(findLeaks([req({ url: `https://api.0xbow.io/x#${LABEL}` })], { labels: [LABEL] }, HOSTS)).toEqual([]);
    expect(findLeaks([req({ url: 'https://fonts.example/font.woff2' })], { labels: [LABEL], amountsWei: [AMOUNT] }, HOSTS)).toEqual([]);
  });

  test('keeps distinct requests with identical URL and timestamp', () => {
    expect(findLeaks([req({ body: LABEL }), req({ body: LABEL })], { labels: [LABEL] }, HOSTS)).toHaveLength(2);
  });

  test('documents the undeclared hash limitation and detects it once declared', () => {
    const hash = createHash('sha256').update(LABEL).digest('hex');
    const request = req({ body: `0x${hash}` });
    expect(findLeaks([request], { labels: [LABEL] }, HOSTS)).toEqual([]);
    expect(findLeaks([request], { labels: [LABEL], labelHashes: [`0x${hash}`] }, HOSTS)).toHaveLength(1);
  });
});

describe('destination policy boundaries', () => {
  for (const host of ['privacypools.com.evil.test', 'evilprivacypools.com', 'relayer.0xbow.io.evil.test', 'alchemy.com.evil.test', 'api.0xbow.io.evil.test', 'preview.privacypools.com']) test(`does not grant trust to ${host}`, () => {
    expect(classifyDestination(`https://${host}/`, HOSTS)).toBe('other');
    expect(findLeaks([req({ url: `https://${host}/`, body: LABEL })], { labels: [LABEL] }, HOSTS)).toHaveLength(1);
  });
  test('normalizes case and DNS root dot, and respects origin scheme and port', () => {
    expect(classifyDestination('https://API.0XBOW.IO./x', HOSTS)).toBe('asp');
    const hosts = { ...HOSTS, ownOrigin: ['http://localhost:8081'] };
    expect(classifyDestination('http://localhost:8081/x', hosts)).toBe('own-origin');
    expect(classifyDestination('http://localhost:8082/x', hosts)).toBe('other');
    expect(classifyDestination('https://localhost:8081/x', hosts)).toBe('other');
    expect(classifyDestination('https://privacypools.com:8443/x', HOSTS)).toBe('other');
    expect(classifyDestination('https://privacypools.com@evil.test/x', HOSTS)).toBe('other');
  });
  const policies = [
    ['asp', 'https://api.0xbow.io', ['labels', 'labelHashes', 'commitments', 'nullifiers', 'amountsWei', 'addresses']],
    ['rpc', 'https://eth-mainnet.g.alchemy.com', ['labels', 'labelHashes', 'commitments', 'nullifiers', 'amountsWei']],
    ['relayer', 'https://relayer.0xbow.io', ['labels', 'labelHashes', 'commitments']],
    ['own-origin', 'https://privacypools.com', []],
    ['other', 'https://unknown.example', ['labels', 'labelHashes', 'commitments', 'nullifiers', 'amountsWei', 'addresses']],
  ] as const;
  for (const [destination, url, forbidden] of policies) {
    test(`${destination}: every policy cell`, () => {
      const secrets: JourneySecrets = { labels: [LABEL], labelHashes: [LABEL], commitments: [LABEL], nullifiers: [LABEL], amountsWei: [AMOUNT], addresses: ['0x1234567890abcdef1234567890abcdef12345678'] };
      for (const [kind, values] of Object.entries(secrets)) {
        const leaks = findLeaks([req({ url, method: 'POST', body: values[0] })], { [kind]: values }, HOSTS);
        expect(leaks.length).toBe((forbidden as readonly string[]).includes(kind) ? 1 : 0);
      }
    });
  }
});

describe('timing regression cases', () => {
  const url = 'https://api.0xbow.io/1/public/deposit-amounts';
  const polls: AlwaysOnPollMatcher = [{ url, method: 'GET', kind: 'http', body: null, maxRequests: 1 }];
  test('flags extra calls to an otherwise allowed poll', () => {
    const violations = findTimingViolations([req({ url, t: 1100 }), req({ url, t: 1200 })], 1000, 2000, polls);
    expect(violations).toHaveLength(1);
    expect(violations[0].request.t).toBe(1200);
  });
  for (const over of [
    { url: `${url}?amount=${AMOUNT}` }, { url: 'https://evil.test/deposit-amounts' },
    { url, method: 'POST' }, { url, body: LABEL }, { url, kind: 'websocket' as const },
  ]) test(`does not exempt a changed request shape: ${JSON.stringify(over)}`, () => {
    expect(findTimingViolations([req({ t: 1100, ...over })], 1000, 2000, polls)).toHaveLength(1);
  });
  test('uses half-open windows and does not retain counters between calls', () => {
    const requests = [req({ t: 1000 }), req({ t: 2000 })];
    expect(findTimingViolations(requests, 1000, 2000, [])).toHaveLength(1);
    expect(findTimingViolations(requests, 2000, 3000, [])).toHaveLength(1);
    for (let i = 0; i < 2; i++) expect(findTimingViolations([req({ url })], 1000, 2000, polls)).toEqual([]);
  });
  test('rejects invalid windows and unbounded poll budgets', () => {
    expect(() => findTimingViolations([], 2000, 1000, [])).toThrow();
    expect(() => findTimingViolations([], NaN, 1000, [])).toThrow();
    expect(() => findTimingViolations([], 1000, 2000, [{ ...(polls[0] as PollBudget), maxRequests: Infinity }])).toThrow();
  });
});


test('legacy global/sticky timing regexes are repeatable without mutating lastIndex', () => {
  const regex = /deposit-amounts/g;
  regex.lastIndex = 9;
  const requests = [req({ url: 'https://api.0xbow.io/deposit-amounts' }), req({ url: 'https://api.0xbow.io/deposit-amounts' })];
  expect(findTimingViolations(requests, 1000, 2000, [regex])).toEqual([]);
  expect(regex.lastIndex).toBe(9);
});

test('retained dust is checked in amount fields without matching public RPC metadata', () => {
  const secrets = { amountsWei: ['1', '2500000'] };
  expect(findLeaks([req({ body: JSON.stringify({ jsonrpc: '2.0', id: 1, block: 2500000 }) })], secrets, HOSTS)).toEqual([]);
  for (const body of [
    '{"amountWei":"2500000"}', '{"value":"0x01"}',
    '{"nested":{"withdrawalAmount":1}}', 'amount=1',
    Buffer.from('{"amount":"2500000"}').toString('base64'),
    `{"value":"0x${'1'.padStart(64, '0')}"}`,
  ]) expect(findLeaks([req({ body })], secrets, HOSTS)).toHaveLength(1);
  expect(findLeaks([req({ url: 'https://api.0xbow.io/?amount=1' })], secrets, HOSTS)).toHaveLength(1);
  expect(findLeaks([req({ headers: { 'x-withdrawal-amount': '1' } })], secrets, HOSTS)).toHaveLength(1);
  expect(() => findLeaks([], { labels: ['1'] }, HOSTS)).toThrow('No distinctive encoding');
});


test('an RPC cannot receive the private withdrawal amount during preparation', () => {
  const leaks = findLeaks([req({ url: 'https://eth-mainnet.g.alchemy.com/v2/key', method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ data: `0x${BigInt(AMOUNT).toString(16).padStart(64, '0')}` }] }) })], { amountsWei: [AMOUNT] }, HOSTS);
  expect(leaks).toHaveLength(1);
  expect(leaks[0].destination).toBe('rpc');
});


test('decimal amounts do not match ABI word boundaries, but real amount encodings do', () => {
  const amount = '1000000000000000';
  const unrelated = `0x82ad56cb${'1'.padStart(64, '0')}${'20'.padStart(64, '0')}`;
  const request = (body: string) => req({ url: 'https://eth-mainnet.g.alchemy.com', body });
  expect(findLeaks([request(unrelated)], { amountsWei: [amount] }, HOSTS)).toEqual([]);
  for (const body of [JSON.stringify({ amount }), BigInt(amount).toString(16).padStart(64, '0'), Buffer.from(JSON.stringify({ amount })).toString('base64')]) {
    expect(findLeaks([request(body)], { amountsWei: [amount] }, HOSTS)).toHaveLength(1);
  }
});
