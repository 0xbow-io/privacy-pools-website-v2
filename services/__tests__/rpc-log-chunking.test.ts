// eth_getLogs window planning (services/rpc-log-chunking).
//
// Pins the behaviour behind the Citrea withdrawal failure: the public RPC
// caps a query at 1000 blocks and ERRORS past it ("query exceeds max block
// range 1000") rather than truncating, so every window the sweep issues has
// to respect the cap — including the short tail top-up after the ASP fast
// path, which is what actually exceeded it (a ~2975-block tail at a 10k
// window size).

import { describe, expect, test } from 'bun:test';
import { InvalidParamsRpcError, LimitExceededRpcError, RpcRequestError } from 'viem';

import {
  windowForCustomEndpoint,
  DEFAULT_MAX_BLOCK_RANGE,
  classifyLimitError,
  createRangeWindow,
  isRangeLimitError,
  isRateLimitError,
  parseBlockRangeCap,
  sweepLogRange,
} from '@/services/rpc-log-chunking';

/** Sweeps under test never wait on a real timer. */
const noSleep = async () => {};

// The shape the app actually sees: the SDK's EventReadError wrapping viem's
// InvalidParamsRpcError, whose message carries the provider detail.
function citreaRangeError(cap = 1000): Error {
  const viemError = new Error(
    'Invalid parameters were provided to the RPC method.\n\n'
      + 'URL: https://rpc.mainnet.citrea.xyz\n'
      + `Details: query exceeds max block range ${cap}\n`
      + 'Version: viem@2.45.3',
  );
  return new Error(`Event log fetch failed: ${viemError.message}`, { cause: viemError });
}

// A real viem RPC error, so the class-vs-message distinction is tested
// against the actual shapes rather than hand-rolled stand-ins.
function viemRpcError(
  Ctor: typeof InvalidParamsRpcError | typeof LimitExceededRpcError,
  code: number,
  message: string,
): Error {
  return new Ctor(
    new RpcRequestError({ body: {}, error: { code, message }, url: 'https://rpc.mainnet.citrea.xyz' }),
  );
}

/** Fake RPC that enforces `cap` the way Citrea does, recording every window. */
function cappedRpc(cap: bigint) {
  const calls: [bigint, bigint][] = [];
  return {
    calls,
    fetch: async (from: bigint, to: bigint) => {
      calls.push([from, to]);
      if (to - from + 1n > cap) throw citreaRangeError(Number(cap));
      // One synthetic log per window, tagged so ordering is checkable.
      return [`${from}-${to}`];
    },
  };
}

describe('range-limit error detection', () => {
  test('recognises the Citrea block-range rejection through the cause chain', () => {
    expect(isRangeLimitError(citreaRangeError())).toBe(true);
  });

  test('recognises other providers’ cap phrasings', () => {
    expect(isRangeLimitError(new Error('query returned more than 10000 results'))).toBe(true);
    expect(isRangeLimitError(new Error('Log response size exceeded'))).toBe(true);
    expect(isRangeLimitError(new Error('block range is too wide'))).toBe(true);
  });

  test('does not treat transport or auth failures as cap errors', () => {
    // Shrinking cannot fix these — matching them would multiply failed calls.
    expect(isRangeLimitError(new Error('HTTP request failed: 503'))).toBe(false);
    expect(isRangeLimitError(new Error('unauthorized: bad api key'))).toBe(false);
    expect(isRangeLimitError(undefined)).toBe(false);
  });

  test('classifies by message, not by error class', () => {
    // -32602 and -32005 are generic buckets: providers put malformed-param
    // and quota errors in them too, and those must NOT be shrunk around.
    const badParam = viemRpcError(
      InvalidParamsRpcError,
      -32602,
      'invalid argument 0: hex string has length 8, want 64 for common.Hash',
    );
    expect(badParam).toBeInstanceOf(InvalidParamsRpcError);
    expect(isRangeLimitError(badParam)).toBe(false);

    // A live example from the staging mainnet RPC: also -32602.
    const needsToken = viemRpcError(
      InvalidParamsRpcError,
      -32602,
      'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode',
    );
    expect(isRangeLimitError(needsToken)).toBe(false);

    const quota = viemRpcError(LimitExceededRpcError, -32005, 'daily request count exceeded');
    expect(quota).toBeInstanceOf(LimitExceededRpcError);
    expect(isRangeLimitError(quota)).toBe(false);

    // Same classes, but the message names the cap → shrink.
    const tooWide = viemRpcError(InvalidParamsRpcError, -32602, 'query exceeds max block range 1000');
    expect(isRangeLimitError(tooWide)).toBe(true);
    expect(parseBlockRangeCap(tooWide)).toBe(1000n);
  });

  test('separates a provider block-range cap from a dense-region response cap', () => {
    // A block-range cap is a provider property (keep it); a response-volume
    // cap is a property of that region's density (do not keep it).
    expect(classifyLimitError(citreaRangeError())).toBe('range');
    expect(classifyLimitError(new Error('block range is too wide'))).toBe('range');
    expect(classifyLimitError(new Error('eth_getLogs is limited to a 10000 range'))).toBe('range');
    expect(classifyLimitError(new Error('query returned more than 10000 results'))).toBe('volume');
    expect(classifyLimitError(new Error('Log response size exceeded'))).toBe('volume');
    expect(classifyLimitError(new Error('HTTP request failed: 503'))).toBe(null);
  });

  test('recognises rate limits by status and by wording', () => {
    // Retried at the same size — narrowing the window would not help.
    expect(isRateLimitError(Object.assign(new Error('HTTP request failed'), { status: 429 }))).toBe(true);
    expect(isRateLimitError(new Error('Wrapped', { cause: Object.assign(new Error('x'), { status: 429 }) })))
      .toBe(true);
    expect(isRateLimitError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isRateLimitError(citreaRangeError())).toBe(false);
  });

  test('reads the cap out of the message when the provider names one', () => {
    expect(parseBlockRangeCap(citreaRangeError(1000))).toBe(1000n);
    expect(parseBlockRangeCap(new Error('max_block_range: 500'))).toBe(500n);
    expect(parseBlockRangeCap(new Error('maximum block range is 250'))).toBe(250n);
    expect(parseBlockRangeCap(new Error('block range is too wide'))).toBe(null);
    expect(parseBlockRangeCap(new Error('max block range 0'))).toBe(null);
  });
});

describe('sweepLogRange', () => {
  test('a configured cap keeps every window inside it', async () => {
    const rpc = cappedRpc(1000n);
    const logs = await sweepLogRange({
      ...rpc,
      from: 10_000n,
      to: 12_500n,
      window: createRangeWindow(1000n),
    });

    // 2501 blocks / 1000 = three windows, contiguous, none over the cap.
    expect(rpc.calls).toEqual([
      [10_000n, 10_999n],
      [11_000n, 11_999n],
      [12_000n, 12_500n],
    ]);
    expect(logs).toEqual(['10000-10999', '11000-11999', '12000-12500']);
  });

  test('the real failure: a ~3k tail at the 10k default recovers via the named cap', async () => {
    const rpc = cappedRpc(1000n);
    const window = createRangeWindow(); // no per-chain cap configured
    expect(window.maxRange).toBe(DEFAULT_MAX_BLOCK_RANGE);

    const logs = await sweepLogRange({
      ...rpc,
      from: 11_132_246n,
      to: 11_135_220n,
      window,
    });

    // First window is rejected, then the cap from the message is adopted —
    // no blind halving, and the rejected window is re-walked at 1000.
    expect(rpc.calls[0]).toEqual([11_132_246n, 11_135_220n]);
    expect(window.maxRange).toBe(1000n);
    const succeeded = rpc.calls.slice(1);
    expect(succeeded).toEqual([
      [11_132_246n, 11_133_245n],
      [11_133_246n, 11_134_245n],
      [11_134_246n, 11_135_220n],
    ]);
    expect(logs.length).toBe(3);
  });

  test('halves when the provider names no number, and the lesson sticks', async () => {
    const rpc = cappedRpc(600n);
    const window = createRangeWindow(2000n);
    const shrinks: bigint[] = [];
    // Cap error with no parseable number → halving path.
    const fetch = async (from: bigint, to: bigint) => {
      if (to - from + 1n > 600n) {
        rpc.calls.push([from, to]);
        throw new Error('block range is too wide');
      }
      return rpc.fetch(from, to);
    };

    await sweepLogRange({
      fetch,
      from: 0n,
      to: 3999n,
      window,
      onShrink: (_span, next) => shrinks.push(next),
    });

    // 2000 → 1000 → 500 by halving; every later window uses the learned 500,
    // so the second half of the range is never re-rejected.
    expect(shrinks).toEqual([1000n, 500n]);
    expect(window.maxRange).toBe(500n);
    const oversized = rpc.calls.filter(([from, to]) => to - from + 1n > 600n);
    expect(oversized.length).toBe(2);
    // Full coverage, in order, no gaps.
    const ok = rpc.calls.filter(([from, to]) => to - from + 1n <= 600n);
    expect(ok[0][0]).toBe(0n);
    expect(ok[ok.length - 1][1]).toBe(3999n);
    for (let i = 1; i < ok.length; i++) expect(ok[i][0]).toBe(ok[i - 1][1] + 1n);
  });

  test('an unrelated InvalidParamsRpcError costs exactly one request', async () => {
    // The expensive mistake: re-walking a rejected window at a smaller size
    // turns one failed request into many. Only cap errors earn that.
    let calls = 0;
    await expect(
      sweepLogRange({
        fetch: async () => {
          calls++;
          throw viemRpcError(InvalidParamsRpcError, -32602, 'invalid argument 1: unsupported filter field');
        },
        from: 0n,
        to: 9999n,
        window: createRangeWindow(10_000n),
      }),
    ).rejects.toThrow('Invalid parameters');
    expect(calls).toBe(1);
  });

  test('a cap-worded error that shrinking never satisfies gives up bounded', async () => {
    // Belt to the message-classification brace: even if something slips
    // through classification, the shrink budget stops the fan-out.
    let calls = 0;
    await expect(
      sweepLogRange({
        fetch: async () => {
          calls++;
          throw new Error('block range is too wide');
        },
        from: 0n,
        to: 9999n,
        window: createRangeWindow(10_000n),
      }),
    ).rejects.toThrow('block range is too wide');
    // Bounded by MAX_SHRINKS_PER_SWEEP (7 calls today), nowhere near the
    // ~10k single-block requests an unbounded shrink issues over this range.
    expect(calls).toBeLessThan(20);
  });

  test('propagates non-cap errors immediately instead of retrying smaller', async () => {
    let calls = 0;
    await expect(
      sweepLogRange({
        fetch: async () => {
          calls++;
          throw new Error('HTTP request failed: 503 Service Unavailable');
        },
        from: 0n,
        to: 9999n,
        window: createRangeWindow(10_000n),
      }),
    ).rejects.toThrow('503');
    expect(calls).toBe(1);
  });

  test('a cap error on a single block propagates rather than looping', async () => {
    let calls = 0;
    await expect(
      sweepLogRange({
        fetch: async () => {
          calls++;
          throw citreaRangeError();
        },
        from: 7n,
        to: 7n,
        window: createRangeWindow(1000n),
      }),
    ).rejects.toThrow('Event log fetch failed');
    expect(calls).toBe(1);
  });

  test('a dense-region response cap narrows locally but never persists', async () => {
    // Blocks 2000-2999 are dense; everything else is fine at 1000. If that
    // narrowing leaked into the shared window, every later scan in the
    // session would pay 4x the requests forever.
    const calls: [bigint, bigint][] = [];
    const window = createRangeWindow(1000n);
    await sweepLogRange({
      from: 0n,
      to: 3999n,
      window,
      sleep: noSleep,
      fetch: async (from, to) => {
        calls.push([from, to]);
        const dense = from < 3000n && to >= 2000n;
        if (dense && to - from + 1n > 250n) throw new Error('query returned more than 10000 results');
        return [`${from}-${to}`];
      },
    });

    expect(window.maxRange).toBe(1000n); // unchanged by the volume error
    // The dense window bisects locally (1000 → 500 → 250), and the window
    // after it is still fetched at the full 1000.
    expect(calls).toContainEqual([3000n, 3999n]);
    expect(calls.filter(([from, to]) => to - from + 1n === 1000n).length).toBe(4);
  });

  test('retries a rate-limited window at the same size, then succeeds', async () => {
    // A 429 partway through a 500-call Citrea scan must not fail the
    // withdrawal, and must not be mistaken for a too-wide window.
    const attempts: [bigint, bigint][] = [];
    const waits: number[] = [];
    let failures = 2;
    const logs = await sweepLogRange({
      from: 0n,
      to: 999n,
      window: createRangeWindow(1000n),
      sleep: async (ms) => void waits.push(ms),
      fetch: async (from, to) => {
        attempts.push([from, to]);
        if (failures-- > 0) throw Object.assign(new Error('HTTP request failed'), { status: 429 });
        return [`${from}-${to}`];
      },
    });

    expect(attempts).toEqual([[0n, 999n], [0n, 999n], [0n, 999n]]);
    expect(waits).toEqual([1000, 2000]); // linear backoff, window untouched
    expect(logs).toEqual(['0-999']);
  });

  test('gives up on a rate limit that never clears', async () => {
    let calls = 0;
    await expect(
      sweepLogRange({
        from: 0n,
        to: 999n,
        window: createRangeWindow(1000n),
        sleep: noSleep,
        fetch: async () => {
          calls++;
          throw Object.assign(new Error('HTTP request failed: 429'), { status: 429 });
        },
      }),
    ).rejects.toThrow('429');
    expect(calls).toBe(4); // one attempt + MAX_RATE_LIMIT_RETRIES
  });

  test('uses a named cap equal to the rejected span instead of halving', async () => {
    // A provider that rejects at `>= 1000` while naming 1000 would otherwise
    // pin the session at 500 and double every scan's request count.
    const calls: [bigint, bigint][] = [];
    const window = createRangeWindow(1000n);
    await sweepLogRange({
      from: 0n,
      to: 1998n,
      window,
      sleep: noSleep,
      fetch: async (from, to) => {
        calls.push([from, to]);
        if (to - from + 1n >= 1000n) throw citreaRangeError(1000);
        return [`${from}-${to}`];
      },
    });
    expect(window.maxRange).toBe(999n); // not 500n
  });

  test('a wide window returning a huge log set does not blow the argument limit', async () => {
    // `out.push(...logs)` throws RangeError past the engine's argument cap —
    // 1M under bun's JSC, but V8 gives up around ~125k, well inside what a
    // 10k-block window over a busy pool can return. Every log fetch in the
    // app funnels through this path, so it uses a loop instead.
    const huge = Array.from({ length: 1_000_000 }, (_, i) => i);
    const logs = await sweepLogRange({
      from: 0n,
      to: 999n,
      window: createRangeWindow(1000n),
      sleep: noSleep,
      fetch: async () => huge,
    });
    expect(logs.length).toBe(1_000_000);
    expect(logs[999_999]).toBe(999_999);
  });

  test('an empty range issues no calls', async () => {
    const rpc = cappedRpc(1000n);
    expect(await sweepLogRange({ ...rpc, from: 500n, to: 499n, window: createRangeWindow() }))
      .toEqual([]);
    expect(rpc.calls.length).toBe(0);
  });
});

describe('chain configuration', () => {
  // The sweep only respects Citrea's cap if the number reaches it. The
  // config/chains.ts → createRPCInteractor hop can't be imported here
  // (chains.ts pulls in react-native), so this pins the deployment preset
  // that feeds it; the rest is covered by types.
  test('Citrea declares its 1000-block eth_getLogs cap', async () => {
    const { STAGING_CHAINS } = await import('@/config/staging-deployments');
    const citrea = STAGING_CHAINS.find((d) => d.chainId === 4114);
    expect(citrea?.logsMaxBlockRange).toBe(1000n);
    // The window is an inclusive count, so this must be the cap itself
    // (1000 blocks = fromBlock..fromBlock+999), not the span 999.
    expect(citrea!.logsMaxBlockRange! < DEFAULT_MAX_BLOCK_RANGE).toBe(true);
  });
});


describe('RPC head lag', () => {
  const headLag = () => new Error('Event log fetch failed', {
    cause: viemRpcError(InvalidParamsRpcError, -32602, 'block range extends beyond current head block'),
  });

  test('head lag is not a block-range cap', () => {
    expect(classifyLimitError(headLag())).toBeNull();
    expect(isRangeLimitError(headLag())).toBe(false);
  });

  for (const from of [25_980_000n, 25_980_180n]) {
    test(`retries the complete range from ${from}, including a single-block tail`, async () => {
      const to = 25_980_180n;
      const calls: [bigint, bigint][] = [];
      const waits: number[] = [];
      const window = createRangeWindow();
      const logs = await sweepLogRange({
        from, to, window,
        sleep: async (ms) => { waits.push(ms); },
        fetch: async (start, end) => {
          calls.push([start, end]);
          if (calls.length < 3) throw headLag();
          return [{ blockNumber: end, data: 'tail event' }];
        },
      });
      expect(calls).toEqual([[from, to], [from, to], [from, to]]);
      expect(waits).toEqual([2000, 4000]);
      expect(logs).toEqual([{ blockNumber: to, data: 'tail event' }]);
      expect(window.maxRange).toBe(DEFAULT_MAX_BLOCK_RANGE);
    });
  }

  test('persistent lag fails without returning partial success or poisoning later windows', async () => {
    const window = createRangeWindow(100n);
    const calls: [bigint, bigint][] = [];
    const waits: number[] = [];
    await expect(sweepLogRange({
      from: 0n, to: 100n, window,
      sleep: async (ms) => { waits.push(ms); },
      fetch: async (start, end) => {
        calls.push([start, end]);
        if (end === 100n) throw headLag();
        return ['earlier event'];
      },
    })).rejects.toThrow('Event log fetch failed');
    expect(calls).toEqual([[0n, 99n], [100n, 100n], [100n, 100n], [100n, 100n], [100n, 100n]]);
    expect(waits).toEqual([2000, 4000, 6000]);
    expect(window.maxRange).toBe(100n);
  });
});

describe('wide preset windows', () => {
  test('a 2M window rejected without a named cap still narrows to a small cap', async () => {
    const cap = 2000n;
    const window = createRangeWindow(2_000_000n);
    const logs = await sweepLogRange<[bigint, bigint]>({
      from: 0n, to: 3_000_000n, window,
      fetch: async (a, b) => {
        if (b - a + 1n > cap) throw new Error('block range is too wide');
        return [[a, b]];
      },
      sleep: async () => {},
    });
    expect(window.maxRange <= cap).toBe(true);
    // The served windows cover 0..3_000_000 exactly, in order, with no gap.
    let next = 0n;
    for (const [a, b] of logs) { expect(a).toBe(next); next = b + 1n; }
    expect(next).toBe(3_000_001n);
  });

  test('custom endpoints drop Alchemy-sized windows, keep tight chain caps', () => {
    expect(windowForCustomEndpoint(2_000_000n)).toBeUndefined();
    expect(windowForCustomEndpoint(50_000n)).toBeUndefined();
    expect(windowForCustomEndpoint(1000n)).toBe(1000n);
    expect(windowForCustomEndpoint(undefined)).toBeUndefined();
  });
});

test('a wide dense scan recovers every region without exhausting a global volume budget', async () => {
  const window = createRangeWindow(2_000_000n);
  const calls: bigint[] = [];
  const logs = await sweepLogRange({ from: 0n, to: 39_999n, window, sleep: noSleep,
    fetch: async (from, to) => {
      calls.push(to - from + 1n);
      if (to - from + 1n > 2_500n) throw new Error('Log response size exceeded');
      return [{ from, to }];
    },
  });
  expect(calls.slice(0, 5)).toEqual([40_000n, 20_000n, 10_000n, 5_000n, 2_500n]);
  expect(logs).toHaveLength(16);
  expect(logs[0].from).toBe(0n);
  expect(logs.at(-1)!.to).toBe(39_999n);
  for (let i = 1; i < logs.length; i++) expect(logs[i].from).toBe(logs[i - 1].to + 1n);
  expect(window.maxRange).toBe(2_000_000n);
});

test('a 2M window too dense for one response halves instead of dropping to 10k', async () => {
  const window = createRangeWindow(2_000_000n);
  const calls: bigint[] = [];
  await sweepLogRange({ from: 0n, to: 1_999_999n, window, sleep: noSleep,
    fetch: async (from, to) => {
      calls.push(to - from + 1n);
      if (to - from + 1n > 1_000_000n) throw new Error('Log response size exceeded');
      return [];
    },
  });
  expect(calls).toEqual([2_000_000n, 1_000_000n, 1_000_000n]);
});
