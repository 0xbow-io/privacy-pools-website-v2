// The LiFi exact-in preview. `toChainId` was added for the cross-chain shield,
// where the pool sits on a different chain than the wallet; every same-chain
// caller omits it, so its DEFAULT is load-bearing — a toChain that silently
// stopped mirroring fromChain would turn every ordinary swap-deposit preview
// into a bridge quote.
import { describe, expect, mock, test } from 'bun:test';

// The module pulls config, which transitively imports react-native — stub the
// one symbol it needs (same pattern as the other config-touching tests).
mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));

const { fetchLifiExactInQuote } = await import('@/services/lifi-quote');

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const USDC_OP = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';

const realFetch = globalThis.fetch;

/**
 * Capture the URLs the helper builds, answer with a fixed estimate, and ALWAYS
 * put the real fetch back — a stub that leaked would silently answer every
 * later test file in the same process.
 */
async function withStub(
  estimate: { toAmount: string; toAmountMin: string } | null,
  body: (calls: string[]) => Promise<void>,
): Promise<void> {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return {
      ok: true,
      json: async () => (estimate ? { estimate } : {}),
    } as Response;
  }) as typeof fetch;
  try {
    await body(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('fetchLifiExactInQuote', () => {
  test('omitted toChainId means a SAME-chain quote', async () => {
    await withStub({ toAmount: '1000', toAmountMin: '995' }, async (calls) => {
      const out = await fetchLifiExactInQuote({
        chainId: 10,
        fromToken: NATIVE,
        toToken: USDC_OP,
        fromAmountWei: 10n ** 18n,
        fromAddress: '0x98AdDcc75931795eB66c52cA954541c18535E3c0',
      });
      const q = paramsOf(calls[0]!);
      expect(q.get('fromChain')).toBe('10');
      expect(q.get('toChain')).toBe('10');
      expect(out).toEqual({ toAmount: 1000n, toAmountMin: 995n });
    });
  });

  test('toChainId crosses chains without touching the source', async () => {
    await withStub({ toAmount: '191328429', toAmountMin: '190371787' }, async (calls) => {
      await fetchLifiExactInQuote({
        chainId: 1,
        toChainId: 10,
        fromToken: NATIVE,
        toToken: USDC_OP,
        fromAmountWei: 10n ** 17n,
        fromAddress: '0x98AdDcc75931795eB66c52cA954541c18535E3c0',
      });
      const q = paramsOf(calls[0]!);
      expect(q.get('fromChain')).toBe('1');
      expect(q.get('toChain')).toBe('10');
      // The amount is always in the SOURCE token, never converted here.
      expect(q.get('fromAmount')).toBe((10n ** 17n).toString());
    });
  });

  test('an explicit toChainId equal to the source is still same-chain', async () => {
    await withStub({ toAmount: '5', toAmountMin: '5' }, async (calls) => {
      await fetchLifiExactInQuote({
        chainId: 10,
        toChainId: 10,
        fromToken: NATIVE,
        toToken: USDC_OP,
        fromAmountWei: 1n,
        fromAddress: '0x98AdDcc75931795eB66c52cA954541c18535E3c0',
      });
      expect(paramsOf(calls[0]!).get('toChain')).toBe('10');
    });
  });

  test('a zero amount never reaches the network', async () => {
    await withStub({ toAmount: '1', toAmountMin: '1' }, async (calls) => {
      expect(await fetchLifiExactInQuote({
        chainId: 1,
        toChainId: 10,
        fromToken: NATIVE,
        toToken: USDC_OP,
        fromAmountWei: 0n,
        fromAddress: '0x98AdDcc75931795eB66c52cA954541c18535E3c0',
      })).toBeNull();
      expect(calls).toEqual([]);
    });
  });

  test('a response without an estimate is null, not a partial quote', async () => {
    await withStub(null, async () => {
      expect(await fetchLifiExactInQuote({
        chainId: 1,
        toChainId: 10,
        fromToken: NATIVE,
        toToken: USDC_OP,
        fromAmountWei: 10n ** 17n,
        fromAddress: '0x98AdDcc75931795eB66c52cA954541c18535E3c0',
      })).toBeNull();
    });
  });
});
