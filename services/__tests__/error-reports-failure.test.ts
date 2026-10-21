import { describe, expect, test } from 'bun:test';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  HttpRequestError,
  InsufficientFundsError,
  IntrinsicGasTooLowError,
  InternalRpcError,
  TimeoutError,
  TransactionExecutionError,
  UserRejectedRequestError,
  WaitForTransactionReceiptTimeoutError,
} from 'viem';

import { RelayerUnavailableError } from '../relayer-assets';
import { AspBackoffError } from '../asp-backoff';
import { ALLOWED_FLAGS, FAILURE_TAG_KEYS, privateErrorReportEvent } from '../error-reports-event';
import {
  classifyReason,
  exceptionType,
  parseStackFrames,
  resolveStage,
  safeConnector,
  stellarErrorReportStage,
  ERROR_REPORT_REASONS,
  ERROR_REPORT_STAGES,
} from '../error-reports-failure';

const ADDRESS = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const TX_HASH = '0x88df016429689c079f3b2f6ad39fa052532c56795b733da78a91ebe6a713944b';
const AMOUNT = '1234.5678';
const QUERY_URL = `https://v2.privacypools.com/_expo/static/js/web/entry.js?to=${ADDRESS}&amount=${AMOUNT}#frag`;

const META = {
  environment: 'production',
  release: 'abc123',
  knownChainIds: [1, 10, 8453, 11155111],
  knownAssetSymbols: ['ETH', 'USDC', 'USDT'],
  origin: 'https://v2.privacypools.com',
};

function leakyError(): Error {
  const err = new Error(`withdraw ${AMOUNT} ETH to ${ADDRESS} failed, tx ${TX_HASH}, see ${QUERY_URL}`);
  err.stack = [
    `Error: withdraw ${AMOUNT} ETH to ${ADDRESS} failed, tx ${TX_HASH}`,
    `see ${QUERY_URL}`,
    `    at relayWithdrawal (${QUERY_URL}:120:33)`,
    `    at async handleConfirm (https://v2.privacypools.com/_expo/static/js/web/entry.js:88:9)`,
    `    at fn_${ADDRESS.slice(2)} (https://v2.privacypools.com/_expo/static/js/web/entry.js:1:2)`,
    `    at https://v2.privacypools.com/pay/${AMOUNT}/${ADDRESS}?x=1:5:6`,
    `    at Object.<anonymous> (https://v2.privacypools.com/${TX_HASH}.js:3:4)`,
  ].join('\n');
  return err;
}

function failureEvent(failure: Record<string, unknown>) {
  return { event_id: 'a'.repeat(32), contexts: { errorReport: { message: 'deposit-failed', testMode: false, failure } } };
}

describe('classifyReason: the class, never the text', () => {
  test('viem classes map to their reason', () => {
    const rejected = new UserRejectedRequestError(new Error('nope'));
    expect(classifyReason(rejected)).toBe('user-rejected');
    expect(classifyReason({ code: 4001 })).toBe('user-rejected');
    expect(classifyReason(new InsufficientFundsError())).toBe('insufficient-funds');
    expect(classifyReason(new IntrinsicGasTooLowError())).toBe('insufficient-gas');
    expect(classifyReason(new TimeoutError({ body: {}, url: 'https://rpc.example' }))).toBe('timeout');
    expect(classifyReason(new WaitForTransactionReceiptTimeoutError({ hash: TX_HASH }))).toBe('timeout');
    expect(classifyReason(new HttpRequestError({ url: 'https://rpc.example', status: 502 }))).toBe('rpc-error');
    expect(classifyReason(new InternalRpcError(new Error('x')))).toBe('rpc-error');
    expect(classifyReason({ code: -32603 })).toBe('rpc-error');
    expect(classifyReason({ status: 503 })).toBe('rpc-error');
  });

  test('a revert is found under its wrapper', () => {
    const reverted = new ContractFunctionRevertedError({ abi: [], functionName: 'deposit' });
    const wrapped = new ContractFunctionExecutionError(reverted, { abi: [], functionName: 'deposit', args: [] });
    expect(classifyReason(wrapped)).toBe('revert');
  });

  test('a user rejection anywhere in the chain wins', () => {
    const wrapped = new TransactionExecutionError(new UserRejectedRequestError(new Error('x')), { account: null });
    expect(classifyReason(wrapped)).toBe('user-rejected');
  });

  test('DOM abort and timeout errors', () => {
    expect(classifyReason(new DOMException('aborted', 'AbortError'))).toBe('timeout');
    expect(classifyReason(new DOMException('slow', 'TimeoutError'))).toBe('timeout');
  });

  test('our own refusals', () => {
    expect(classifyReason(new RelayerUnavailableError('Cannot confirm'))).toBe('relayer-unavailable');
    expect(classifyReason(new AspBackoffError(5000))).toBe('asp-unavailable');
    const sdkAsp = Object.assign(new Error('ASP unavailable: x'), { name: 'ASPUnavailable' });
    expect(classifyReason(sdkAsp)).toBe('asp-unavailable');
    const sdkRelayer = Object.assign(new Error('relayer said no'), { name: 'RelayerRequestFailed' });
    expect(classifyReason(sdkRelayer)).toBe('relayer-unavailable');
  });

  test('message text alone classifies nothing', () => {
    expect(classifyReason(new Error('User rejected the request. insufficient funds. execution reverted. timeout'))).toBe('unknown');
    expect(classifyReason('user rejected')).toBe('unknown');
    expect(classifyReason(undefined)).toBe('unknown');
    expect(classifyReason({ errorReportReason: 'something-new' })).toBe('unknown');
  });

  test('a cyclic cause chain terminates', () => {
    const a: { name: string; cause?: unknown } = { name: 'X' };
    a.cause = a;
    expect(classifyReason(a)).toBe('unknown');
  });
});

describe('stage', () => {
  test('explicit names fold onto the enum, catch-alls yield to the phase', () => {
    expect(resolveStage('fee-quote', 'proof')).toBe('quote');
    expect(resolveStage('evm-submit', 'approve')).toBe('approve');
    expect(resolveStage('evm-submit', 'unknown')).toBe('submit');
    expect(resolveStage(undefined, 'confirm')).toBe('confirm');
    expect(resolveStage('something-else', 'not-a-stage')).toBe('unknown');
    expect(resolveStage('batch-receipt-unknown', undefined)).toBe('confirm');
  });

  test('the enums are frozen', () => {
    expect(Object.isFrozen(ERROR_REPORT_STAGES)).toBe(true);
    expect(Object.isFrozen(ERROR_REPORT_REASONS)).toBe(true);
  });
});

describe('context', () => {
  test('connector ids outside the allowlist are `other`', () => {
    expect(safeConnector('io.metamask')).toBe('io.metamask');
    expect(safeConnector('com.someone.custom-wallet')).toBe('other');
    expect(safeConnector(undefined)).toBe('unknown');
  });

  test('chain and asset come only from the configured lists', () => {
    const event = privateErrorReportEvent(failureEvent({
      stage: 'approve', chainId: 1, asset: 'USDC', isYield: true, walletKind: 'eoa', connector: 'io.rabby',
    }), META, new Error('x'));
    expect(event?.tags).toEqual({
      stage: 'approve', reason: 'unknown', walletKind: 'eoa', connector: 'io.rabby',
      chainId: '1', asset: 'USDC', isYield: 'true',
    });
    const odd = privateErrorReportEvent(failureEvent({
      stage: 'weird', chainId: 424242, asset: 'SCAMCOIN', isYield: 'yes', walletKind: 'hardware', connector: 'x.y',
    }), META);
    expect(odd?.tags).toEqual({ stage: 'unknown', reason: 'unknown', walletKind: 'unknown', connector: 'other', asset: 'other' });
  });

  test('a caller cannot choose the reason', () => {
    const event = privateErrorReportEvent(failureEvent({ reason: ADDRESS }), META, new UserRejectedRequestError(new Error('x')));
    expect(event?.tags?.reason).toBe('user-rejected');
  });
});

describe('frames', () => {
  const ORIGIN = { origin: 'https://v2.privacypools.com' };
  const CHUNK = '/_expo/static/js/web/entry-0123456789abcdef0123456789abcdef.js';

  test('V8 frames are parsed, oldest first, with origin, query and hash removed', () => {
    const frames = parseStackFrames(leakyError().stack, { ...ORIGIN, message: leakyError().message });
    expect(frames[frames.length - 1]).toEqual({
      function: 'relayWithdrawal',
      filename: '/_expo/static/js/web/entry.js',
      abs_path: '/_expo/static/js/web/entry.js',
      lineno: 120,
      colno: 33,
      in_app: true,
    });
    expect(frames.find((f) => f.lineno === 88)?.function).toBe('handleConfirm');
  });

  test('Gecko frames are parsed, and only build chunks are kept', () => {
    const frames = parseStackFrames(`deposit@https://v2.privacypools.com${CHUNK}?q=1:10:20\n@https://v2.privacypools.com/a.js:1:1`, ORIGIN);
    expect(frames.map((f) => [f.function, f.filename, f.lineno, f.colno])).toEqual([['deposit', CHUNK, 10, 20]]);
  });

  test('without the app origin no frame is kept', () => {
    expect(parseStackFrames(`    at f (https://v2.privacypools.com${CHUNK}:1:2)`)).toEqual([]);
  });

  test('a frame-shaped line inside a multiline message is never parsed', () => {
    const message = `failed\n    at x (/pay/${AMOUNT}.js:1:1)\n    at y (https://v2.privacypools.com/_expo/static/js/web/pay${AMOUNT.replace('.', '')}.js:1:1)`;
    const err = new Error(message);
    err.stack = `Error: ${message}\n    at real (https://v2.privacypools.com${CHUNK}:5:6)`;
    const frames = parseStackFrames(err.stack, { ...ORIGIN, message });
    expect(frames).toEqual([{ function: 'real', filename: CHUNK, abs_path: CHUNK, lineno: 5, colno: 6, in_app: true }]);
    // Unknown message: the first line is skipped and non-build paths are dropped.
    const blind = parseStackFrames(`Error: x\n    at x (/pay/${AMOUNT}.js:1:1)\n    at real (https://v2.privacypools.com${CHUNK}:5:6)`, ORIGIN);
    expect(JSON.stringify(blind)).not.toContain(AMOUNT);
    expect(blind).toHaveLength(1);
  });

  test('local files, extensions, foreign hosts and protocol-relative URLs are dropped', () => {
    for (const location of [
      'file:///home/alice/projects/ppv2/entry.js',
      `file:///home/alice${CHUNK}`,
      'chrome-extension://abcdefghijklmnop/inpage.js',
      `https://evil.example${CHUNK}`,
      `https://v2.privacypools.com.evil.example${CHUNK}`,
      `//v2.privacypools.com${CHUNK}`,
      `http://localhost:8081${CHUNK}`,
      `https://v2.privacypools.com/pay/${AMOUNT}.js`,
    ]) {
      expect({ location, frames: parseStackFrames(`Error: x\n    at f (${location}:1:2)`, ORIGIN) }).toEqual({ location, frames: [] });
    }
  });

  test('the real chunk names of a build are kept', () => {
    // From a local `build:web` dry run.
    for (const name of [
      '__common-c98a2eebc2aea035b06956865dca82fd.js',
      'index-d633bcebf70df9e27720dd99c1345379.js',
      'bootstrap-part-0a1b2c3d4e5f60718293a4b5.js',
      'stellar-claim-url-7ab06545fd6de8fb3a42b6d6dabb2c67.js',
      'sui-encoding-d9358b971bf0c08fa4d7a376f32cfc3d.js',
    ]) {
      const path = `/_expo/static/js/web/${name}`;
      expect(parseStackFrames(`Error: x\n    at f (https://v2.privacypools.com${path}:1:2)`, ORIGIN).map((f) => f.abs_path)).toEqual([path]);
      expect(parseStackFrames(`Error: x\n    at f (https://evil.example${path}:1:2)`, ORIGIN)).toEqual([]);
    }
  });

  test('a function name that is not a plain identifier becomes ?', () => {
    const [frame] = parseStackFrames(`Error: x\n    at pay ${AMOUNT} (https://v2.privacypools.com${CHUNK}:1:2)`, ORIGIN);
    expect(frame?.function).toBe('?');
  });

  test('exception type is a bare identifier', () => {
    expect(exceptionType(new TypeError('x'))).toBe('TypeError');
    expect(exceptionType(Object.assign(new Error('x'), { name: `Bad ${ADDRESS}` }))).toBe('Error');
    expect(exceptionType('plain string')).toBe('StringError');
  });
});

describe('the whole event', () => {
  const ALLOWED_TOP_LEVEL = ['event_id', 'timestamp', 'platform', 'environment', 'release', 'level', 'message', 'contexts', 'tags', 'exception'];

  function build() {
    const err = leakyError();
    const event = {
      event_id: 'b'.repeat(32),
      timestamp: 1_760_000_000,
      message: err.message,
      request: { url: QUERY_URL },
      user: { ip_address: '203.0.113.9', id: ADDRESS },
      breadcrumbs: [{ message: QUERY_URL }],
      extra: { amount: AMOUNT, txHash: TX_HASH },
      exception: { values: [{ type: 'Error', value: err.message, stacktrace: { frames: [{ vars: { amount: AMOUNT } }] } }] },
      contexts: {
        errorReport: {
          message: 'deposit-failed',
          testMode: false,
          isUserRejected: false,
          walletAddressFlag: true,
          hasAmount: AMOUNT,
          failure: {
            stage: 'submit', chainId: 1, asset: 'ETH', isYield: false, walletKind: 'smart', connector: 'walletConnect',
            address: ADDRESS, amount: AMOUNT, txHash: TX_HASH,
          },
          diagnostic: { address: ADDRESS, amount: AMOUNT, detail: err.message },
        },
      },
    };
    return privateErrorReportEvent(event, META, err);
  }

  test('only allowlisted keys, at every level', () => {
    const out = build()!;
    for (const key of Object.keys(out)) expect(ALLOWED_TOP_LEVEL).toContain(key);
    for (const key of Object.keys(out.tags ?? {})) expect(FAILURE_TAG_KEYS as readonly string[]).toContain(key);
    expect(Object.keys(out.contexts ?? {})).toEqual(['flags']);
    for (const key of Object.keys(out.contexts?.flags ?? {})) expect(ALLOWED_FLAGS as readonly string[]).toContain(key);
    expect(out.contexts?.flags).toEqual({ testMode: false, isUserRejected: false });
    expect(out.exception?.values).toHaveLength(1);
    const value = out.exception!.values[0]!;
    expect(Object.keys(value).sort()).toEqual(['stacktrace', 'type']);
    for (const frame of value.stacktrace!.frames) {
      expect(Object.keys(frame).sort().filter((k) => !['lineno', 'colno'].includes(k)))
        .toEqual(['abs_path', 'filename', 'function', 'in_app']);
    }
    expect(out.tags).toEqual({
      stage: 'submit', reason: 'unknown', walletKind: 'smart', connector: 'walletConnect',
      chainId: '1', asset: 'ETH', isYield: 'false',
    });
  });

  test('an address, an amount, a tx hash and a query URL in the message and stack leak nowhere', () => {
    const json = JSON.stringify(build());
    for (const secret of [ADDRESS, ADDRESS.toLowerCase(), ADDRESS.slice(2), TX_HASH, TX_HASH.slice(2), AMOUNT, '203.0.113.9', 'v2.privacypools.com', '?to=', 'amount=', '#frag', 'https://']) {
      expect({ secret, leaked: json.includes(secret) }).toEqual({ secret, leaked: false });
    }
    // Long hex runs of any kind, which is what an address or a hash looks like.
    expect(/[0-9a-fA-F]{32,}/.test(json.replace(/"event_id":"b{32}"/, ''))).toBe(false);
  });

  test('without a failure bag, no tags and no exception are added', () => {
    const out = privateErrorReportEvent({ contexts: { errorReport: { message: 'withdraw-failed' } } }, META, leakyError());
    expect(out?.tags).toBeUndefined();
    expect(out?.exception).toBeUndefined();
  });
});

describe('relayed spends say less', () => {
  const relayed = (message: string, stage: string) => ({
    event_id: 'c'.repeat(32),
    contexts: {
      errorReport: {
        message,
        testMode: false,
        isNetworkError: true,
        code: { errorName: 'TypeError' },
        diagnostic: { address: ADDRESS, amount: AMOUNT },
        failure: { stage, chainId: 1, asset: 'ETH', isYield: true, walletKind: 'eoa', connector: 'io.metamask' },
      },
    },
  });

  const json = (value: unknown) => JSON.stringify(value);

  test('before anything is sent: the normal event, without wallet kind or connector', () => {
    for (const stage of ['validate', 'quote', 'proof', 'relayer-check', 'recipient-check']) {
      const out = privateErrorReportEvent(relayed('withdraw-failed', stage), META, leakyError())!;
      expect(out.tags).toEqual({ stage, reason: 'unknown', chainId: '1', asset: 'ETH', isYield: 'true' });
      expect(out.exception?.values[0]?.stacktrace?.frames.length).toBeGreaterThan(0);
      expect(json(out)).not.toContain('io.metamask');
    }
  });

  test('a submit the relayer explicitly refused (HTTP 4xx) keeps its context', () => {
    const refused = Object.assign(new Error('bad request'), { name: 'RelayerRequestFailed', status: 400 });
    const out = privateErrorReportEvent(relayed('withdraw-failed', 'submit'), META, refused)!;
    expect(out.tags).toEqual({ stage: 'submit', reason: 'relayer-unavailable', chainId: '1', asset: 'ETH', isYield: 'true' });
  });

  test('a submit with an unknown outcome is treated as broadcast', () => {
    const timedOut = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const network = new TypeError('Failed to fetch');
    const gateway = Object.assign(new Error('g'), { name: 'RelayerRequestFailed', status: 504 });
    for (const error of [timedOut, network, gateway, leakyError()]) {
      const out = privateErrorReportEvent(relayed('withdraw-failed', 'submit'), META, error)!;
      expect(Object.keys(out.tags!).sort()).toEqual(['reason', 'stage']);
      expect(out.contexts).toBeUndefined();
    }
  });

  test('a partial or unknown batch is treated as broadcast', () => {
    for (const stage of ['submit', 'unknown']) {
      const out = privateErrorReportEvent(relayed('transfer-failed', stage), META, leakyError())!;
      expect(Object.keys(out.tags!).sort()).toEqual(['reason', 'stage']);
    }
  });

  test('after the relayer accepted: only stage, reason, exception type and frames', () => {
    for (const message of ['withdraw-failed', 'transfer-failed', 'swap-failed', 'ragequit-failed']) {
      const out = privateErrorReportEvent(relayed(message, 'confirm'), { ...META, diagnosticsAllowed: true }, leakyError())!;
      expect(out).not.toBeNull();
      expect(out.tags).toEqual({ stage: 'confirm', reason: 'unknown' });
      expect(out.contexts).toBeUndefined();
      expect(Object.keys(out).sort()).toEqual(['environment', 'event_id', 'exception', 'level', 'message', 'platform', 'release', 'tags']);
      expect(Object.keys(out.exception!.values[0]!).sort()).toEqual(['stacktrace', 'type']);
      for (const dropped of ['chainId', 'asset', 'isYield', 'walletKind', 'connector', 'io.metamask', ADDRESS, AMOUNT]) {
        expect({ dropped, present: json(out).includes(dropped) }).toEqual({ dropped, present: false });
      }
    }
  });

  test('an on-chain revert is treated as accepted', () => {
    const reverted = new ContractFunctionRevertedError({ abi: [], functionName: 'relay' });
    const out = privateErrorReportEvent(relayed('withdraw-failed', 'submit'), META, reverted)!;
    expect(out.tags).toEqual({ stage: 'submit', reason: 'revert' });
  });

  test('deposits keep their full context', () => {
    const out = privateErrorReportEvent(relayed('deposit-failed', 'confirm'), META, leakyError())!;
    expect(out.tags).toMatchObject({ stage: 'confirm', chainId: '1', asset: 'ETH', walletKind: 'eoa', connector: 'io.metamask' });
  });
});

describe('Expo chunk filenames', () => {
  test('the content hash survives only as a chunk basename under /_expo/static/js/web/', () => {
    const o = { origin: 'https://v2.privacypools.com' };
    const [kept] = parseStackFrames('Error: x\n    at f (https://v2.privacypools.com/_expo/static/js/web/index-532b339d87f811aa20f1bcb98740dc25.js:1:2)', o);
    expect(kept).toMatchObject({ filename: '/_expo/static/js/web/index-532b339d87f811aa20f1bcb98740dc25.js', in_app: true });
    expect(parseStackFrames('Error: x\n    at f (https://v2.privacypools.com/other/index-532b339d87f811aa20f1bcb98740dc25.js:1:2)', o)).toEqual([]);
    expect(parseStackFrames(`Error: x\n    at f (https://v2.privacypools.com/_expo/static/${ADDRESS}/index-532b339d87f811aa20f1bcb98740dc25.js:1:2)`, o)).toEqual([]);
    expect(parseStackFrames(`Error: x\n    at f (https://v2.privacypools.com/_expo/static/js/web/${ADDRESS.slice(2)}.js:1:2)`, o)).toEqual([]);
  });
});

describe('review fixes', () => {
  test('an HTTP 408 or 504 is a timeout even inside HttpRequestError', () => {
    expect(classifyReason(new HttpRequestError({ url: 'https://rpc.example', status: 504 }))).toBe('timeout');
    expect(classifyReason(new HttpRequestError({ url: 'https://rpc.example', status: 408 }))).toBe('timeout');
  });

  test('Stellar session stages fold onto the enum', () => {
    expect(stellarErrorReportStage('proving')).toBe('proof');
    expect(stellarErrorReportStage('syncing')).toBe('confirm');
    expect(stellarErrorReportStage('relaying')).toBe('submit');
    expect(stellarErrorReportStage('something')).toBe('unknown');
  });
});

describe('debug_meta: source map ids for the frames, nothing else', () => {
  const ENTRY = '/_expo/static/js/web/entry-0123456789abcdef0123456789abcdef.js';
  const LAZY = '/_expo/static/js/web/lazy-fedcba9876543210fedcba9876543210.js';
  const ID = '9c1f6f0e-2b7a-4d3e-8f41-5a6b7c8d9e0f';
  const registry = {
    [`Error\n    at https://v2.privacypools.com${ENTRY}?to=${ADDRESS}:1:20`]: ID.toUpperCase(),
    [`Error\n    at https://v2.privacypools.com${LAZY}:1:20`]: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    [`Error\n    at https://v2.privacypools.com/pay/${ADDRESS}.js:1:2`]: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
    [`Error\n    at https://v2.privacypools.com${ENTRY}:1:20`]: `${ADDRESS}`,
  };
  function error(): Error {
    const err = new Error(`to ${ADDRESS}`);
    err.stack = `Error: to ${ADDRESS}\n    at handleConfirm (https://v2.privacypools.com${ENTRY}?x=${AMOUNT}:88:9)`;
    return err;
  }

  test('an image per frame file, as a bare path and a lowercase uuid', () => {
    const out = privateErrorReportEvent(failureEvent({ stage: 'submit' }), { ...META, debugIds: () => registry }, error())!;
    expect(out.debug_meta).toEqual({ images: [{ type: 'sourcemap', code_file: ENTRY, debug_id: ID }] });
    expect(out.exception?.values[0]?.stacktrace?.frames[0]?.abs_path).toBe(ENTRY);
    const json = JSON.stringify(out);
    for (const secret of [ADDRESS, AMOUNT, 'privacypools.com', LAZY]) expect(json).not.toContain(secret);
  });

  test('absent without frames, without a registry, or when the registry throws', () => {
    const noStack = Object.assign(new Error('x'), { stack: undefined });
    expect(privateErrorReportEvent(failureEvent({ stage: 'submit' }), { ...META, debugIds: () => registry }, noStack)!.debug_meta).toBeUndefined();
    expect(privateErrorReportEvent(failureEvent({ stage: 'submit' }), META, error())!.debug_meta).toBeUndefined();
    const boom = () => { throw new Error('blocked'); };
    expect(privateErrorReportEvent(failureEvent({ stage: 'submit' }), { ...META, debugIds: boom }, error())!.debug_meta).toBeUndefined();
    expect(privateErrorReportEvent(failureEvent({ stage: 'submit' }), { ...META, debugIds: () => 'nope' }, error())!.debug_meta).toBeUndefined();
  });
});
