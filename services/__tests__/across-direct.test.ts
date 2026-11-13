import { afterEach, beforeEach, describe, expect, test as it } from 'bun:test';

import {
  ACROSS_DIRECT_BRIDGE,
  acrossDirectEnabled,
  acrossDirectServes,
  acrossDirectSourceChainIds,
  acrossMulticallHandler,
  acrossSpokePool,
  canPollBridgeStatus,
  isAcrossSpokePool,
  statusBridgeFor,
} from '@/config/across-direct';
import { checkEgress } from '@/services/egress-policy';
import { acrossWiring, withAcrossDirect, type QuoteProviderLike } from '@/services/across-provider';
import { fetchAcrossDirectEstimate } from '@/services/across-quote';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as acrossConfig from '@/config/across-direct';
import * as lifiAddresses from '@/config/lifi-addresses';
import * as nativeDelivery from '@/services/lifi-native-delivery';

import type { Address } from '@/services/sdk-types';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_OP = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const WALLET = '0x8ba1f109551bD432803012645Ac136ddd64DBA72';
const BASE_SPOKE = '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64';
const ARB_SPOKE = '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A';

// Load real quote and approval code without the React Native configuration graph.
// No global module mocks: these tests also run independently of the full suite.
function loadSource(file: string, dependencies: Record<string, unknown>, names?: string[]) {
  const source = readFileSync(new URL('../../' + file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const selected = names ? ast.statements.filter((node) =>
    (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && names.includes(node.name.text),
  ).map((node) => node.getText(ast)).join('\n') : source;
  const code = ts.transpileModule(selected, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, unknown> = {};
  const require = (name: string) => {
    if (!(name in dependencies)) throw new Error('Unexpected dependency: ' + name);
    return dependencies[name];
  };
  const globals = names ? dependencies : {};
  new Function('require', 'exports', ...Object.keys(globals), code)(require, exports, ...Object.values(globals));
  return exports;
}
const { fetchLifiContractCallDeliverable, fetchLifiExactInQuote } = loadSource('services/lifi-quote.ts', {
  '@/config/intent-swaps': { LIFI_API_KEY: '', NATIVE_ASSET_ADDRESS: NATIVE },
  '@/services/lifi-native-delivery': nativeDelivery,
  '@/config/across-direct': acrossConfig,
  '@/services/across-quote': { fetchAcrossDirectEstimate },
}) as typeof import('@/services/lifi-quote');
const { assertApprovalSpender } = loadSource('services/swap-flows.ts', {
  ...lifiAddresses,
  acrossDirectSourceChainIds,
  isAcrossSpokePool,
}, ['UnexpectedSwapTxError', 'assertApprovalSpender']) as typeof import('@/services/swap-flows');

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

  it('never polls a direct Across transfer by transaction hash', () => {
    expect(canPollBridgeStatus(ACROSS_DIRECT_BRIDGE)).toBe(false);
    expect(canPollBridgeStatus(undefined)).toBe(true);
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

  it('keeps browser quoting on LI.FI until a private quote transport exists', () => {
    setEnv('true', '8453,10');
    expect(withAcrossDirect(lifi, sdk)).toBe(lifi);
    expect(acrossWiring(sdk)).toEqual({ kind: 'lifi-only', reason: 'privacy-transport-unavailable' });
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

  it('never sends action-timed previews, even with the flag on', async () => {
    setEnv('true', '8453');
    const seen = stubFetch(() => json({}, 500));
    expect(await fetchAcrossDirectEstimate({ ...base, destinationCall: false })).toBeNull();
    expect(await fetchAcrossDirectEstimate({ ...base, destinationCall: true })).toBeNull();
    expect(seen).toEqual([]);
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

  it('retains LI.FI quotes for every route when the flag is on', async () => {
    setEnv('true', '8453');
    const seen = stubFetch(() => json({}, 404));
    await fetchLifiExactInQuote(params);
    await fetchLifiContractCallDeliverable({ ...params, slippage: 0.03 });
    expect(seen.map((u) => u.host)).toEqual(['li.quest', 'li.quest']);
  });
});

describe('Across egress policy', () => {
  it('refuses quotes, note messages, status hashes, and unknown routes', () => {
    for (const path of [
      '/api/suggested-fees?amount=100&recipient=' + WALLET,
      '/api/suggested-fees?message=0x' + 'ab'.repeat(32),
      '/api/deposit/status?depositTxnRef=0x' + 'ab'.repeat(32),
      '/api/unknown',
    ]) {
      expect(checkEgress('across', { method: 'GET', url: 'https://app.across.to' + path }).allowed).toBe(false);
    }
  });
});
