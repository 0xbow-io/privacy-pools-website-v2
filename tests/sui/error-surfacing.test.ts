import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * Error decoding / surfacing.
 *
 * FIXED (audit bug #2): the website now has a Move-abort decoder
 * (services/sui-witness/abort-codes.ts). The Sui hooks' catch paths run thrown
 * errors through `friendlyError`, so an on-chain abort `MoveAbort(... }, N)`
 * surfaces as `<E_NAME>: <friendly message>` (e.g. `E_GVK_MISMATCH: ...`).
 * Non-Move errors (network failures, validation) still pass through verbatim.
 *
 * Note: the abort CODE for E_GVK_MISMATCH is `69` (pool.move:51). The earlier
 * gap-test fixture used `659`, which is the SOURCE LINE pool.move:659 where the
 * assert lives — NOT the abort code. We bind the real code here.
 */

/**
 * The hook destructures `[value, setter]` at call time, so the returned object's
 * `error` is frozen at the initial value. To OBSERVE the surfaced message we
 * record every value passed to a setState whose initial value was `null` (the
 * `error` slot) into a global recorder, and read the last recorded value.
 */
const SET_NULL_SLOT_VALUES: unknown[] = [];

vi.mock('react', () => ({
  useState: <T,>(init: T) => {
    const set = (next: T | ((p: T) => T)) => {
      const v = typeof next === 'function' ? (next as (p: T) => T)(init) : next;
      // The `error` state is the only one initialized to null; record its writes.
      if (init === null) SET_NULL_SLOT_VALUES.push(v);
    };
    return [init, set] as const;
  },
  useCallback: <T,>(fn: T) => fn,
  useRef: <T,>(initVal: T) => ({ current: initVal }),
}));

import { useSuiRelay } from '@/hooks/use-sui-relay';

/** The most recent non-null value written to the `error` state slot. */
function lastSurfacedError(): string | null {
  for (let i = SET_NULL_SLOT_VALUES.length - 1; i >= 0; i--) {
    const v = SET_NULL_SLOT_VALUES[i];
    if (typeof v === 'string') return v;
  }
  return null;
}

afterEach(() => {
  vi.restoreAllMocks();
  SET_NULL_SLOT_VALUES.length = 0;
});

describe('Move-abort decoding in the relay hook catch path', () => {
  it('decodes an on-chain E_GVK_MISMATCH (pool code 69) into a friendly message', async () => {
    const origFetch = globalThis.fetch;
    // Simulate the relayer returning an on-chain MoveAbort verbatim in its body.
    // 69 = pool::E_GVK_MISMATCH (sources/pool.move:51).
    const moveAbort =
      'MoveAbort(MoveLocation { module: ModuleId { address: 0x1edf..., name: Identifier("pool") }, function: 12, instruction: 7, function_name: Some("transact_internal") }, 69)';
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.includes('/v1/relay/withdrawal')) {
        return new Response(JSON.stringify({ error: moveAbort }), { status: 400 });
      }
      return new Response('{}', { status: 200 });
    }) as never;

    const relay = useSuiRelay();
    const res = await relay.submitRelay({
      relayerUrl: 'https://r',
      proofBytes: '0x00',
      n: 1,
      m: 1,
      nullifierHashes: ['1'],
      outputCommitments: ['2'],
      stateRoot: '3',
      keystoreRoot: '4',
      aspRoot: '5',
      amountOut: '1000',
      tokenIdOut: '0',
      coinType: '0x2::sui::SUI',
      recipient: '0xrec',
      feeAmount: '10',
      noteHints: [],
      noteData: [],
    });

    globalThis.fetch = origFetch;
    // The submit fails closed (null), and the abort is now DECODED into a
    // human-readable E_* name + message (not the raw MoveAbort string).
    expect(res).toBeNull();
    const surfaced = lastSurfacedError();
    expect(surfaced).toContain('E_GVK_MISMATCH');
    expect(surfaced).toMatch(/Global View Key/i);
    expect(surfaced).toContain('pool::69');
    // The raw MoveAbort noise is gone.
    expect(surfaced).not.toContain('MoveLocation');
  });

  it('surfaces a request-failure reason verbatim (no decoder)', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as never;
    const relay = useSuiRelay();
    const v = await relay.getValidatedQuote({ relayerUrl: 'https://r', asset: '0x2::sui::SUI', amount: '1000' });
    globalThis.fetch = origFetch;
    expect(v).toBeNull();
    expect(lastSurfacedError()).toMatch(/relayer request failed: network down/);
  });
});
