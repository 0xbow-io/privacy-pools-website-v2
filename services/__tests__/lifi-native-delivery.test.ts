import { describe, expect, test as it } from 'bun:test';
import { LiFiSwapQuoteProvider } from '@privacy-pools-v2/sdk';
import { contractCallDeniedBridges, installNativeDeliveryBridgeDeny } from '@/services/lifi-native-delivery';

const NATIVE = '0x0000000000000000000000000000000000000000';
const NATIVE_EEE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const OP_WETH = '0x4200000000000000000000000000000000000006';
const OP_PPETH_ROUTER = '0xc0FBB5D5936a6f089C1B30Ff0Fd0BEAd27b9F766';

describe('contractCallDeniedBridges', () => {
  it('denies Across only for a cross-chain native delivery', () => {
    expect(contractCallDeniedBridges(8453, 10, NATIVE)).toEqual(['across']);
    expect(contractCallDeniedBridges(10, 8453, NATIVE_EEE)).toEqual(['across']);
  });
  it('leaves same-chain and ERC-20 deliveries alone', () => {
    expect(contractCallDeniedBridges(10, 10, NATIVE)).toBeUndefined();
    expect(contractCallDeniedBridges(10, undefined, NATIVE)).toBeUndefined();
    expect(contractCallDeniedBridges(8453, 10, OP_WETH)).toBeUndefined();
  });
});

// Drives the REAL SDK provider and captures the body it posts to LiFi.
function newProvider(): LiFiSwapQuoteProvider {
  const provider = new LiFiSwapQuoteProvider({});
  installNativeDeliveryBridgeDeny(provider as never);
  return provider;
}

async function postedBody(
  params: Record<string, unknown>,
  provider: LiFiSwapQuoteProvider = newProvider(),
): Promise<Record<string, unknown>> {
  const realFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    if (init?.body && !body) body = JSON.parse(init.body);
    return new Response(JSON.stringify({ message: 'stub' }), { status: 400 });
  }) as typeof fetch;
  try {
    await (provider as unknown as { getSwapAndDepositQuote: (p: unknown) => Promise<unknown> })
      .getSwapAndDepositQuote(params)
      .catch(() => undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
  if (!body) throw new Error('the SDK posted no body');
  return body;
}

const base = {
  fromToken: NATIVE,
  fromAddress: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
  depositAmount: '5000000000000000',
  poolAddress: OP_PPETH_ROUTER,
  depositCalldata: '0xdeadbeef',
};

describe('installNativeDeliveryBridgeDeny on the SDK provider', () => {
  it('adds denyBridges for a cross-chain native delivery', async () => {
    const body = await postedBody({ ...base, fromChainId: 8453, toChainId: 10, toToken: NATIVE });
    expect(body.denyBridges).toEqual(['across']);
  });
  it('sends no deny list for a cross-chain WETH delivery or a same-chain call', async () => {
    expect((await postedBody({ ...base, fromChainId: 8453, toChainId: 10, toToken: OP_WETH })).denyBridges).toBeUndefined();
    expect((await postedBody({ ...base, fromChainId: 10, toChainId: 10, toToken: NATIVE })).denyBridges).toBeUndefined();
  });
  it('does not leak the deny list into later quotes on the same provider', async () => {
    const provider = newProvider();
    const native = { ...base, fromChainId: 8453, toChainId: 10, toToken: NATIVE };
    expect((await postedBody(native, provider)).denyBridges).toEqual(['across']);
    expect((await postedBody({ ...base, fromChainId: 8453, toChainId: 10, toToken: OP_WETH }, provider)).denyBridges)
      .toBeUndefined();
    expect((await postedBody({ ...base, fromChainId: 10, toChainId: 10, toToken: NATIVE }, provider)).denyBridges)
      .toBeUndefined();
    expect((await postedBody(native, provider)).denyBridges).toEqual(['across']);
  });
  it('does not leak the deny list into a plain swap quote that shares bridgeFilter', async () => {
    const provider = newProvider();
    await postedBody({ ...base, fromChainId: 8453, toChainId: 10, toToken: NATIVE }, provider);
    const realFetch = globalThis.fetch;
    let url = '';
    globalThis.fetch = (async (input: unknown) => {
      if (!url) url = String(input instanceof Request ? input.url : input);
      return new Response(JSON.stringify({ message: 'stub' }), { status: 400 });
    }) as typeof fetch;
    try {
      await (provider as unknown as { getSwapQuote: (p: unknown) => Promise<unknown> })
        .getSwapQuote({
          fromChainId: 8453, toChainId: 10, fromToken: NATIVE, toToken: NATIVE,
          fromAddress: base.fromAddress, toAddress: base.fromAddress,
          amount: base.depositAmount, amountType: 'exactIn',
        })
        .catch(() => undefined);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(url).toContain('li.quest');
    expect(url).not.toContain('denyBridges');
  });
});
