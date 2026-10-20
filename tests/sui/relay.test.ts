import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Relay safety (use-sui-relay): the SDK's RelayerClient + RelayWithdrawBuilder
 * port. These assert the fail-CLOSED quote validation, the fetch timeout, and the
 * context binding the caller uses. Live relay submission (real proof + the
 * relayer's on-chain relay::relay_withdrawal) is covered by the Node live
 * scripts, not here.
 *
 * `validateQuote` is exported standalone (pure) and tested directly. To exercise
 * the timeout + state machine in `useSuiRelay` without a DOM, we shim React's
 * `useState`/`useCallback`/`useRef` to trivial implementations (the hook uses no
 * effects), so the returned callbacks run as plain async functions.
 */

// Shim React so the hook can be invoked as a plain function (no renderer).
vi.mock('react', () => {
  return {
    useState: <T,>(init: T) => {
      let v: T = init;
      const set = (next: T | ((p: T) => T)) => {
        v = typeof next === 'function' ? (next as (p: T) => T)(v) : next;
      };
      return [v, set] as const;
    },
    useCallback: <T,>(fn: T) => fn,
    useRef: <T,>(init: T) => ({ current: init }),
    useMemo: <T,>(fn: () => T) => fn(),
  };
});

import { validateQuote, RelayQuoteError, useSuiRelay } from '@/hooks/use-sui-relay';
import { makeQuote } from './helpers/fixtures';

const ASSET = '0x2::sui::SUI';
const AMOUNT = 1_000_000n;

describe('validateQuote (fail-CLOSED)', () => {
  it('accepts a well-formed, live, in-bounds quote', () => {
    const v = validateQuote(makeQuote() as never, { amount: AMOUNT, asset: ASSET });
    expect(v.feeAmount).toBe(1000n);
    expect(v.commitment.asset).toBe(ASSET);
  });

  it('rejects a non-object quote', () => {
    expect(() => validateQuote(null as never, { amount: AMOUNT, asset: ASSET })).toThrow(RelayQuoteError);
  });

  it('rejects a quote with no signed fee commitment', () => {
    const q = makeQuote({ feeCommitment: undefined });
    expect(() => validateQuote(q as never, { amount: AMOUNT, asset: ASSET })).toThrow(
      /no signed fee commitment/,
    );
  });

  it('rejects an asset mismatch between commitment and caller intent', () => {
    const q = makeQuote({ commitmentOverrides: { asset: '0xother::coin::COIN' } });
    expect(() => validateQuote(q as never, { amount: AMOUNT, asset: ASSET })).toThrow(
      /does not match caller asset/,
    );
  });

  it('rejects when top-level feeAmount disagrees with the signed commitment', () => {
    const q = makeQuote({ feeAmount: '2000' }); // commitment still says 1000
    expect(() => validateQuote(q as never, { amount: AMOUNT, asset: ASSET })).toThrow(
      /does not match signed commitment/,
    );
  });

  it('rejects a fee greater than the withdrawal amount', () => {
    const q = makeQuote({
      feeAmount: (AMOUNT + 1n).toString(),
      commitmentOverrides: { feeAmount: (AMOUNT + 1n).toString() },
    });
    expect(() => validateQuote(q as never, { amount: AMOUNT, asset: ASSET })).toThrow(
      /exceeds withdrawal amount/,
    );
  });

  it('rejects a fee exceeding the caller maxFeeAmount', () => {
    const q = makeQuote();
    expect(() =>
      validateQuote(q as never, { amount: AMOUNT, asset: ASSET, maxFeeAmount: 500n }),
    ).toThrow(/exceeds caller maxFeeAmount/);
  });

  it('rejects an expired fee commitment (<= now)', () => {
    const q = makeQuote({ commitmentOverrides: { expiresAt: Date.now() - 1 } });
    expect(() => validateQuote(q as never, { amount: AMOUNT, asset: ASSET })).toThrow(/expired/);
  });

  it('rejects a malformed (non-integer-string) feeAmount', () => {
    const q = makeQuote({ feeAmount: '10.5', commitmentOverrides: { feeAmount: '10.5' } });
    expect(() => validateQuote(q as never, { amount: AMOUNT, asset: ASSET })).toThrow(
      /not a non-negative integer string/,
    );
  });

  it('rejects a missing signature on the commitment', () => {
    const q = makeQuote({ commitmentOverrides: { signature: '' } });
    expect(() => validateQuote(q as never, { amount: AMOUNT, asset: ASSET })).toThrow(/signature/);
  });
});

/** Minimal well-formed submitRelay params (fetch is mocked; values inert). */
function makeSubmitParams() {
  return {
    relayerUrl: 'https://r',
    proofBytes: '0x00',
    n: 1,
    m: 1,
    nullifierHashes: ['1'],
    outputCommitments: ['2'],
    stateRoot: '3',
    keystoreRoot: '4',
    aspRoot: '5',
    amountOut: '1000000',
    tokenIdOut: '1',
    coinType: '0x2::sui::SUI',
    recipient: '0x' + 'ab'.repeat(32),
    feeAmount: '1000',
    noteHints: [],
    noteData: [],
  };
}

describe('useSuiRelay (React-shimmed) network behavior', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it('getValidatedQuote returns a validated quote for a good relayer response', async () => {
    const quote = makeQuote();
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(quote), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    ) as never;

    const relay = useSuiRelay();
    const v = await relay.getValidatedQuote({ relayerUrl: 'https://r', asset: ASSET, amount: AMOUNT.toString() });
    expect(v).not.toBeNull();
    expect(v?.feeAmount).toBe(1000n);
    // It POSTed to /v1/quote/withdrawal with commit:true.
    const call = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call[0]).toBe('https://r/v1/quote/withdrawal');
    const body = JSON.parse((call[1] as { body: string }).body);
    expect(body).toMatchObject({ asset: ASSET, amount: AMOUNT.toString(), commit: true });
  });

  it('getValidatedQuote returns null (fails closed) on a bad quote', async () => {
    const bad = makeQuote({ commitmentOverrides: { asset: '0xWRONG' } });
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(bad), { status: 200 })) as never;
    const relay = useSuiRelay();
    const v = await relay.getValidatedQuote({ relayerUrl: 'https://r', asset: ASSET, amount: AMOUNT.toString() });
    expect(v).toBeNull();
  });

  it('submitRelay accepts a well-formed success body (control)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ txDigest: 'DigestOk123' }), { status: 200 }),
    ) as never;
    const relay = useSuiRelay();
    const r = await relay.submitRelay(makeSubmitParams() as never);
    expect(r).not.toBeNull();
    expect(r?.txDigest).toBe('DigestOk123');
    expect(r?.amountReceived).toBe('999000');
  });

  it('submitRelay FAILS CLOSED on a success body with NO txDigest (round-3 finding 1)', async () => {
    // A relayer answering `{ "success": true }` has not proven any submitted
    // tx — treating it as success would let callers mark local notes spent.
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    ) as never;
    const relay = useSuiRelay();
    const r = await relay.submitRelay(makeSubmitParams() as never);
    expect(r).toBeNull();
  });

  it('submitRelay FAILS CLOSED on an empty-string txDigest', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ txDigest: '' }), { status: 200 }),
    ) as never;
    const relay = useSuiRelay();
    const r = await relay.submitRelay(makeSubmitParams() as never);
    expect(r).toBeNull();
  });

  it('submitRelay FAILS CLOSED on a non-string txDigest', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ txDigest: 12345 }), { status: 200 }),
    ) as never;
    const relay = useSuiRelay();
    const r = await relay.submitRelay(makeSubmitParams() as never);
    expect(r).toBeNull();
  });

  it('FETCH TIMEOUT fires on a hanging relayer (request does not block forever)', async () => {
    // A fetch that respects AbortSignal: rejects when aborted, otherwise hangs.
    globalThis.fetch = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener('abort', () => {
              const e = new Error('aborted');
              e.name = 'AbortError';
              reject(e);
            });
          }
        }),
    ) as never;

    vi.useFakeTimers();
    const relay = useSuiRelay();
    const promise = relay.getValidatedQuote({
      relayerUrl: 'https://r',
      asset: ASSET,
      amount: AMOUNT.toString(),
    });
    // Advance past the 30s default timeout -> the AbortController fires.
    await vi.advanceTimersByTimeAsync(31_000);
    const v = await promise;
    vi.useRealTimers();
    // The hook catches the timeout error, sets status=error, and returns null.
    expect(v).toBeNull();
    expect(relay.error == null || /timed out|aborted|failed/i.test(relay.error)).toBe(true);
  });
});
