import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test';

import {
  ACROSS_DIRECT_BRIDGE,
  acrossDirectEnabled,
  acrossDirectServes,
  acrossDirectSourceChainIds,
  acrossMulticallHandler,
  acrossSpokePool,
  isAcrossSpokePool,
  statusBridgeFor,
} from '@/config/across-direct';
import { acrossWiring, withAcrossDirect, type QuoteProviderLike } from '@/services/across-provider';
import { fetchAcrossDirectEstimate } from '@/services/across-quote';
import { fetchLifiContractCallDeliverable, fetchLifiExactInQuote } from '@/services/lifi-quote';
import { assertApprovalSpender } from '@/services/swap-flows';
import type { Address } from '@/services/sdk-types';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_OP = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const WALLET = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const BASE_SPOKE = '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64';
const ARB_SPOKE = '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A';

const savedFlag = process.env.EXPO_PUBLIC_ACROSS_DIRECT;
const savedChains = process.env.EXPO_PUBLIC_ACROSS_DIRECT_CHAINS;
const realFetch = globalThis.fetch;

function setEnv(flag: string | undefined, chains: string | undefined): void {
  if (flag === undefined) delete process.env.EXPO_PUBLIC_ACROSS_DIRECT;
  else process.env.EXPO_PUBLIC_ACROSS_DIRECT = flag;
  if (chains === undefined) delete process.env.EXPO_PUBLIC_ACROSS_DIRECT_CHAINS;
  else process.env.EXPO_PUBLIC_ACROSS_DIRECT_CHAINS = chains;
}

/** Captures every URL fetched and answers each with `answer(url)`. */
function stubFetch(answer: (url: URL) => Response): URL[] {
  const seen: URL[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    seen.push(url);
    return answer(url);
  }) as typeof fetch;
  return seen;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const acrossFees = (amount: bigint, extra: Record<string, unknown> = {}) => ({
  outputAmount: (amount - 1_000n).toString(),
  relayerGasFee: { total: '300' },
  inputToken: { decimals: 6 },
  outputToken: { decimals: 6 },
  ...extra,
});

beforeEach(() => setEnv(undefined, undefined));
afterEach(() => {
  setEnv(savedFlag, savedChains);
  globalThis.fetch = realFetch;
});

describe('config/across-direct', () => {
  it('is off unless the flag is exactly true', () => {
    expect(acrossDirectEnabled()).toBe(false);
    setEnv('1', '8453');
    expect(acrossDirectEnabled()).toBe(false);
    expect(acrossDirectSourceChainIds()).toEqual([]);
    setEnv('true', '8453');
    expect(acrossDirectEnabled()).toBe(true);
  });

  it('enables only listed chains that Across serves', () => {
    setEnv('true', '8453, 10,4114,abc');
    expect(acrossDirectSourceChainIds().sort()).toEqual([10, 8453]);
    setEnv('true', '');
    expect(acrossDirectSourceChainIds()).toEqual([]);
  });

  it('pins SpokePools per chain and names the status bridge only for them', () => {
    expect(acrossSpokePool(4114)).toBeUndefined();
    expect(isAcrossSpokePool(8453, BASE_SPOKE.toLowerCase())).toBe(true);
    expect(isAcrossSpokePool(10, BASE_SPOKE)).toBe(false);
    expect(statusBridgeFor(BASE_SPOKE)).toBe(ACROSS_DIRECT_BRIDGE);
    expect(statusBridgeFor('0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE')).toBeUndefined();
    expect(statusBridgeFor(undefined)).toBeUndefined();
    expect(acrossMulticallHandler(4663)).toBeUndefined();
  });

  it('serves only cross-chain ERC-20 routes from an enabled source chain', () => {
    setEnv('true', '8453');
    const route = { fromChainId: 8453, toChainId: 10, fromToken: USDC_BASE, toToken: USDC_OP, destinationCall: true };
    expect(acrossDirectServes(route)).toBe(true);
    expect(acrossDirectServes({ ...route, toChainId: 8453 })).toBe(false);
    expect(acrossDirectServes({ ...route, fromChainId: 10, toChainId: 8453 })).toBe(false);
    expect(acrossDirectServes({ ...route, fromToken: NATIVE })).toBe(false);
    expect(acrossDirectServes({ ...route, toChainId: 4114 })).toBe(false);
    expect(acrossDirectServes({ ...route, toChainId: 4663 })).toBe(false);
    expect(acrossDirectServes({ ...route, toChainId: 4663, destinationCall: false })).toBe(true);
  });
});

describe('withAcrossDirect', () => {
  const lifi: QuoteProviderLike = {
    getSwapQuote: async () => 'lifi',
    getSwapAndDepositQuote: async () => 'lifi',
    getSwapStatus: async () => 'lifi',
  };
  class FakeAcross {
    constructor(public config: Record<string, unknown>) {}
    getSwapQuote = async () => 'across';
    getSwapAndDepositQuote = async () => 'across';
    getSwapStatus = async () => 'across';
  }
  class FakePrefer {
    constructor(public config: Record<string, unknown>) {}
    getSwapQuote = async () => 'prefer';
    getSwapAndDepositQuote = async () => 'prefer';
    getSwapStatus = async () => 'prefer';
  }
  const sdk = { AcrossBridgeQuoteProvider: FakeAcross, PreferAcrossSwapQuoteProvider: FakePrefer } as never;

  it('returns the LiFi provider itself when the flag is off', () => {
    expect(withAcrossDirect(lifi, sdk)).toBe(lifi);
    expect(acrossWiring(sdk)).toEqual({ kind: 'lifi-only', reason: 'flag-off' });
  });

  it('returns the LiFi provider when no source chain is listed', () => {
    setEnv('true', '');
    expect(withAcrossDirect(lifi, sdk)).toBe(lifi);
  });

  it('stays inert on an SDK without the Across classes', () => {
    setEnv('true', '8453');
    expect(withAcrossDirect(lifi, {})).toBe(lifi);
    expect(acrossWiring({})).toEqual({ kind: 'lifi-only', reason: 'sdk-without-across' });
  });

  it('wraps LiFi with Across first for the enabled chains', () => {
    setEnv('true', '8453,10');
    const wrapped = withAcrossDirect(lifi, sdk) as unknown as FakePrefer;
    expect(wrapped).toBeInstanceOf(FakePrefer);
    expect(wrapped.config.fallback).toBe(lifi);
    expect(wrapped.config.across).toBeInstanceOf(FakeAcross);
    expect((wrapped.config.sourceChainIds as number[]).sort()).toEqual([10, 8453]);
  });
});

describe('assertApprovalSpender and the Across SpokePool', () => {
  it('refuses the SpokePool while direct Across is off for the chain', () => {
    expect(() => assertApprovalSpender(8453, BASE_SPOKE as Address)).toThrow();
    setEnv('true', '10');
    expect(() => assertApprovalSpender(8453, BASE_SPOKE as Address)).toThrow();
  });

  it("accepts the chain's own SpokePool once enabled, including where LiFi has no table", () => {
    setEnv('true', '8453,42161');
    expect(assertApprovalSpender(8453, BASE_SPOKE as Address)).toBe(BASE_SPOKE as Address);
    expect(assertApprovalSpender(42161, ARB_SPOKE as Address)).toBe(ARB_SPOKE as Address);
  });

  it("never accepts another chain's SpokePool", () => {
    setEnv('true', '8453,42161');
    expect(() => assertApprovalSpender(8453, ARB_SPOKE as Address)).toThrow();
  });
});

describe('fetchAcrossDirectEstimate', () => {
  const base = {
    chainId: 8453,
    toChainId: 10,
    fromToken: USDC_BASE,
    toToken: USDC_OP,
    fromAmountWei: 100_000_000n,
    recipient: WALLET,
  };

  it('prices a plain bridge to the recipient at its exact output', async () => {
    const seen = stubFetch((url) => json(acrossFees(BigInt(url.searchParams.get('amount')!))));
    const est = await fetchAcrossDirectEstimate({ ...base, destinationCall: false });
    expect(est).toEqual({ toAmount: 99_999_000n, deliverableMin: 99_999_000n, fromDecimals: 6 });
    expect(seen[0]!.origin + seen[0]!.pathname).toBe('https://app.across.to/api/suggested-fees');
    expect(seen[0]!.searchParams.get('recipient')).toBe(WALLET);
    expect([...seen[0]!.searchParams.keys()].sort()).toEqual(
      ['amount', 'destinationChainId', 'inputToken', 'originChainId', 'outputToken', 'recipient'],
    );
  });

  it('holds back one relayer-gas fee for a deposit-ending route, quoted to the handler', async () => {
    const seen = stubFetch((url) => json(acrossFees(BigInt(url.searchParams.get('amount')!))));
    const est = await fetchAcrossDirectEstimate({ ...base, destinationCall: true });
    expect(est?.deliverableMin).toBe(99_998_700n);
    expect(seen[0]!.searchParams.get('recipient')).toBe(acrossMulticallHandler(10)!);
  });

  it('returns null on refusal, a too-low amount or unmatched decimals', async () => {
    stubFetch(() => json({ message: 'Route is not enabled.' }, 400));
    expect(await fetchAcrossDirectEstimate({ ...base, destinationCall: false })).toBeNull();
    stubFetch(() => json({ ...acrossFees(1n), isAmountTooLow: true }));
    expect(await fetchAcrossDirectEstimate({ ...base, destinationCall: false })).toBeNull();
    stubFetch((url) => json(acrossFees(BigInt(url.searchParams.get('amount')!), { outputToken: { decimals: 18 } })));
    expect(await fetchAcrossDirectEstimate({ ...base, destinationCall: false })).toBeNull();
  });
});

describe('LI.FI previews with direct Across', () => {
  const params = {
    chainId: 8453,
    toChainId: 10,
    fromToken: USDC_BASE,
    toToken: USDC_OP,
    fromAmountWei: 100_000_000n,
    fromAddress: WALLET,
  };

  it('never calls Across while the flag is off', async () => {
    const seen = stubFetch(() => json({}, 404));
    await fetchLifiExactInQuote(params);
    await fetchLifiContractCallDeliverable({ ...params, slippage: 0.03 });
    expect(seen.every((u) => u.host === 'li.quest')).toBe(true);
  });

  it('previews an eligible route on Across only', async () => {
    setEnv('true', '8453');
    const seen = stubFetch((url) => json(acrossFees(BigInt(url.searchParams.get('amount')!))));
    expect(await fetchLifiExactInQuote(params)).toEqual({ toAmount: 99_999_000n, toAmountMin: 99_999_000n });
    const deliverable = await fetchLifiContractCallDeliverable({ ...params, slippage: 0.03 });
    expect(deliverable?.tool).toBe('across-direct');
    expect(deliverable?.deliverableMin).toBe(99_998_700n);
    expect(seen.map((u) => u.host)).toEqual(['app.across.to', 'app.across.to']);
  });

  it('falls back to LI.FI when Across refuses the route', async () => {
    setEnv('true', '8453');
    const seen = stubFetch((url) => (url.host === 'app.across.to' ? json({}, 400) : json({}, 404)));
    await fetchLifiExactInQuote(params);
    expect(seen.map((u) => u.host)).toEqual(['app.across.to', 'li.quest']);
  });
});
