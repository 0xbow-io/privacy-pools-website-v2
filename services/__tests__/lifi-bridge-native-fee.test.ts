import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The module pulls config, which transitively imports react-native.
mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));

const { deliverableAfterNativeFee, fetchLifiContractCallDeliverable } = await import('@/services/lifi-quote');

/**
 * A real li.quest /v1/quote/contractCalls response (trimmed to the fields the
 * helper reads), captured 2026-09-27 for 20 USDT BNB -> Ethereum with the
 * preview's probe call. Stargate was the only route, with a LayerZero fee
 * charged on top of the tokens. The plain /v1/quote for the same pair went
 * through Across and showed ~19.50, which is what the Swap tab displayed.
 */
const FIXTURE = readFileSync(join(new URL('.', import.meta.url).pathname, 'fixtures', 'lifi-contractcalls-bsc-eth-usdt.json'), 'utf8');
const TWENTY = 20n * 10n ** 18n;

const realFetch = globalThis.fetch;
async function withResponse<T>(body: string, run: () => Promise<T>): Promise<T> {
  globalThis.fetch = (async () => ({ ok: true, json: async () => JSON.parse(body) }) as Response) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

function quote() {
  return withResponse(FIXTURE, () => fetchLifiContractCallDeliverable({
    chainId: 56,
    toChainId: 1,
    fromToken: '0x55d398326f99059fF775485246999027B3197955',
    toToken: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    fromAmountWei: TWENTY,
    fromAddress: '0xd0395c08DD8eA7671a7A65bDca8E473e8E8260a8',
    slippage: 0.03,
  }));
}

describe('bridge native fee in the cross-chain preview', () => {
  test('the fee LiFi leaves out of toAmount is read off the quote', async () => {
    const q = await quote();
    expect(q).not.toBeNull();
    expect(q!.tool).toBe('stargateV2');
    // Only the fee charged ON TOP counts; LI.FI's own fixed fee is already inside toAmount.
    expect(q!.nativeFeeUsd).toBeCloseTo(6.8509, 4);
    expect(q!.fromDecimals).toBe(18);
    expect(q!.toAmount).toBe(19_932_603n);
  });

  test('the estimate nets the gas swap that pays that fee', async () => {
    const q = (await quote())!;
    const net = deliverableAfterNativeFee(q, TWENTY)!;
    // 6.8509 * 1.2726 / 0.99956 = 8.72 USDT swapped for gas, 11.28 bridged.
    expect(Number(net) / 1e6).toBeGreaterThan(11.1);
    expect(Number(net) / 1e6).toBeLessThan(11.4);
    // Nowhere near the raw quote the old preview showed.
    expect(net < q.toAmount - 8_000_000n).toBe(true);
  });

  test('the 2026-09-27 run: an $8.90 fee on 20 USDT leaves about what the SDK deposited', () => {
    // The SDK's gas swap took 11.33 USDT and deposited ~8.48; the bridge
    // delivered 99.66% of what it was given on that route.
    const net = deliverableAfterNativeFee({
      toAmount: 19_932_603n,
      nativeFeeUsd: 8.9023,
      fromPriceUsd: 0.9995616173,
      fromDecimals: 18,
    }, TWENTY)!;
    expect(Number(net) / 1e6).toBeGreaterThan(8.5);
    expect(Number(net) / 1e6).toBeLessThan(8.8);
  });

  test('a route with no fee on top keeps its quote', () => {
    expect(deliverableAfterNativeFee({ toAmount: 19_500_000n, nativeFeeUsd: 0, fromPriceUsd: null, fromDecimals: null }, TWENTY))
      .toBe(19_500_000n);
  });

  test('a fee that cannot be priced, or eats the input, gives no estimate', () => {
    expect(deliverableAfterNativeFee({ toAmount: 1n, nativeFeeUsd: 5, fromPriceUsd: null, fromDecimals: 18 }, TWENTY)).toBeNull();
    expect(deliverableAfterNativeFee({ toAmount: 1n, nativeFeeUsd: 50, fromPriceUsd: 1, fromDecimals: 18 }, TWENTY)).toBeNull();
  });
});
