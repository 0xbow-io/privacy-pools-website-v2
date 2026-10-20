// What an RPC failure may say in a log line (services/rpc-error-text.ts).
//
// This file exists because the first version of that module had no tests and
// was materially wrong: it trusted `shortMessage`, which the vendored SDK's
// wrapped errors do not have, so the dominant failure path still wrote the
// user's endpoint and API key into an exportable buffer.
import { describe, expect, test } from 'bun:test';

import { describeErrorFrames, describeRpcError } from '../rpc-error-text';

const ENDPOINT = 'https://eth-mainnet.g.alchemy.com/v2/SECRET_KEY_abc123';

/** How viem 2.x builds an HTTP error message. */
const viemMessage = [
  'HTTP request failed.',
  '',
  `URL: ${ENDPOINT}`,
  'Request body: {"method":"eth_getLogs","params":[{"fromBlock":"0x1"}]}',
  '',
  'Details: Failed to fetch',
  'Version: viem@2.45.3',
].join('\n');

class ViemHttpError extends Error {
  shortMessage = 'HTTP request failed.';
  url = ENDPOINT;
  constructor() {
    super(viemMessage);
    this.name = 'HttpRequestError';
  }
}

/**
 * How the vendored SDK re-throws it: `new ContractReadError(error.message)`.
 * No shortMessage, and no cause to walk back to - which is what made the
 * first implementation useless on the path that matters.
 */
class SdkContractReadError extends Error {
  constructor() {
    super(`Contract read failed: ${viemMessage}`);
    this.name = 'ContractReadError';
  }
}

describe('the endpoint never survives into a log line', () => {
  const cases: [string, unknown][] = [
    ['a raw viem error', new ViemHttpError()],
    ['an SDK-wrapped error with no shortMessage and no cause', new SdkContractReadError()],
    ['a wrapped error that kept its cause', Object.assign(new Error(`Event read failed: ${viemMessage}`), { cause: new ViemHttpError() })],
    ['a plain Error carrying the URL', new Error(`fetch failed for ${ENDPOINT}`)],
    ['a thrown string', `boom at ${ENDPOINT}`],
  ];

  for (const [name, err] of cases) {
    test(name, () => {
      const described = describeRpcError(err);
      expect(described).not.toContain(ENDPOINT);
      expect(described).not.toContain('SECRET_KEY_abc123');
      expect(described).not.toContain('alchemy.com');
      // And it still says something, or the log line is useless.
      expect(described.length).toBeGreaterThan(0);
    });
  }

  test('it keeps the part that identifies the failure', () => {
    expect(describeRpcError(new ViemHttpError())).toBe('HTTP request failed.');
    expect(describeRpcError(new SdkContractReadError())).toBe('Contract read failed: HTTP request failed.');
  });

  test('a shortMessage that is itself multi-line is still cut to one line', () => {
    const err = Object.assign(new Error('x'), { shortMessage: `bad\nURL: ${ENDPOINT}` });
    expect(describeRpcError(err)).toBe('bad');
  });

  test('nothing, undefined and a cause cycle are all survivable', () => {
    expect(describeRpcError(undefined).length).toBeGreaterThan(0);
    expect(describeRpcError(null).length).toBeGreaterThan(0);
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(() => describeRpcError(a)).not.toThrow();
  });
});

describe('stack frames, never the stack header', () => {
  test('the header line carries the whole message, so only "at" frames come through', () => {
    const err = new ViemHttpError();
    err.stack = `HttpRequestError: ${viemMessage}\n    at doFetch (app.js:1:1)\n    at scan (app.js:2:2)`;
    const frames = describeErrorFrames(err);
    expect(frames).toBe('at doFetch (app.js:1:1) | at scan (app.js:2:2)');
    expect(frames).not.toContain(ENDPOINT);
  });

  test('no stack, or a stack with no frames, yields nothing rather than the header', () => {
    const bare = new Error('x');
    bare.stack = `Error: ${viemMessage}`;
    expect(describeErrorFrames(bare)).toBeUndefined();
    expect(describeErrorFrames('not an error')).toBeUndefined();
  });
});
