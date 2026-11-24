// @ts-nocheck -- Exercise SDK private sizing methods against the unpatched pinned package.
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { previewReshieldInput } from '../swap-preview-input';
import { estimateSwapNote } from '../swap-note-preview';
import * as patched from '@privacy-pools-v2/sdk';

const dir = mkdtempSync(join(tmpdir(), 'lifi-fee-baseline-'));
const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const sdkArchive = manifest.dependencies['@privacy-pools-v2/sdk'];
if (!sdkArchive.startsWith('file:')) throw new Error('Expected a vendored SDK archive for the parity baseline');
execFileSync('tar', ['-xzf', resolve(sdkArchive.slice('file:'.length)), '--strip-components=1', '-C', dir]);
symlinkSync(resolve('node_modules'), join(dir, 'node_modules'));
const baseline = await import(join(dir, 'dist/index.js'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const address = n => `0x${String(n).padStart(40, '0')}`;
const fee = n => [{ name: 'LIFI Fixed Fee', amount: String(n), included: true, token: { address: address(1), chainId: 1, symbol: 'USDC', decimals: 6 } }];
const withoutFees = value => JSON.parse(JSON.stringify(value, (key, x) => key === 'feeCosts' ? undefined : typeof x === 'bigint' ? x.toString() : x));

test('real provider keeps request, calldata, amounts and logs identical; fees stay on their own concurrent response', async () => {
  async function run(sdk) {
    const requests = [], logs = [];
    const provider = new sdk.LiFiSwapQuoteProvider({}, { fetch: async (url, init) => {
      requests.push([String(url), init]);
      const amount = new URL(String(url)).searchParams.get('fromAmount');
      await Promise.resolve();
      return new Response(JSON.stringify({
        estimate: { fromAmount: amount, toAmount: '950', toAmountMin: '900', executionDuration: 1, feeCosts: fee(amount) },
        action: { fromChainId: 1, toChainId: 1, fromToken: { address: address(1), symbol: 'USDC', decimals: 6 }, toToken: { address: address(2), symbol: 'USDT', decimals: 6 } },
        transactionRequest: { data: '0x1234', to: address(3) }, tool: 'test',
      }));
    } });
    provider.logger = { debug: (...args) => logs.push(args) };
    const results = await Promise.all(['1000', '2000'].map(amount => provider.getSwapQuote({ fromChainId: 1, toChainId: 1, fromToken: address(1), toToken: address(2), fromAddress: address(3), amount, amountType: 'from' })));
    return { requests, logs, results };
  }
  const old = await run(baseline), next = await run(patched);
  expect(next.requests).toEqual(old.requests);
  expect(next.requests).toHaveLength(2);
  expect(next.logs).toEqual(old.logs);
  expect(withoutFees(next.results)).toEqual(old.results);
  expect(next.results.map(r => r.feeCosts)).toEqual([fee(1000), fee(2000)]);
});

for (const { executor, stable, minimum } of [
  { executor: false, stable: true, minimum: 1_000_000_123n },
  { executor: true, stable: true, minimum: 1_000_000_123n },
  { executor: true, stable: false, minimum: 1_000_000_123n },
  { executor: true, stable: true, minimum: 100n },
]) test(`same-chain SDK sizing and selected fees (executor=${executor}, stable=${stable}, minimum=${minimum})`, async () => {
  async function run(sdk) {
    const relayerCalls = [], swapCalls = [];
    const session = Object.create(sdk.PoolSessionReshield.prototype);
    Object.assign(session, {
      chainId: 1, relaySwapsAddress: address(3), emptyAddress: address(0), yieldWrappers: [],
      swapExecutor: { executor: address(4) },
      composesExecutorRoute: () => executor, yieldTargetFor: () => undefined,
      swapChainAdapter: { isSameToken: (a, b) => a === b },
      entrypointInteractor: { getAssetConfig: async () => ({ enabled: true, vettingFeeBPS: 0n, minAmount: 0n, maxRelayFee: 100n }) },
      relayerInteractor: { getSwapQuote: async (_, req) => {
        relayerCalls.push(req);
        return { feeAmount: '5' };
      } },
      swapQuoteProvider: { getSwapQuote: async req => {
        swapCalls.push(req);
        return {
          fromTokenAddress: req.fromToken, toTokenAddress: req.toToken,
          fromChainId: 1, toChainId: 1, fromTokenSymbol: stable ? 'USDT' : 'ETH', toTokenSymbol: 'USDC',
          toAmount: String(minimum + 50n), toAmountMin: String(minimum), feeCosts: fee(swapCalls.length),
        };
      } },
    });
    const result = await session.estimateReshieldAmount({
      relayerInfo: { chainId: 1, address: address(7) }, amount: '0x3e8',
      tokenId: address(1), outputToken: address(2), inputCommitments: [1n, 2n],
    });
    return { result, relayerCalls, swapCalls };
  }
  const old = await run(baseline), next = await run(patched);
  expect(next.relayerCalls).toEqual(old.relayerCalls);
  expect(next.relayerCalls.map(call => call.inputs)).toEqual([2]);
  expect(next.swapCalls).toEqual(old.swapCalls);
  expect(previewReshieldInput(1000n, 5n, executor, false, undefined)).toBe(BigInt(old.swapCalls[0].amount));
  expect(next.swapCalls).toHaveLength(executor && !stable ? 2 : 1);
  const preview = estimateSwapNote({
    minimumOutput: minimum, crossChain: false, destinationChainId: 1,
    executorPair: executor ? (stable ? 'stable' : 'volatile') : undefined,
    config: { enabled: true, vettingFeeBps: 0n, maxRelayFee: 100n },
  });
  expect(preview).toBe(BigInt(old.result.noteValue));
  expect(withoutFees(next.result)).toEqual(withoutFees(old.result));
  expect(next.result.feeCosts).toEqual(fee(next.swapCalls.length));
});

for (const mode of ['plain', 'native', 'gas']) test(`cross-chain ${mode}: selected fees do not change calls, budgets or logs`, async () => {
  async function run(sdk) {
    const calls = [], logs = [];
    const session = Object.create(sdk.PoolSessionReshieldCrosschain.prototype);
    const config = { enabled: true, vettingFeeBPS: 0n, minAmount: 0n, maxRelayFee: 1000n };
    const native = address(9);
    let probes = 0;
    Object.assign(session, {
      chainId: 1, destinationChainId: 10, destinationChainType: 'evm', nativeAssetAddress: native, emptyAddress: address(0), yieldWrappers: [],
      logger: { info: (...args) => logs.push(args) },
      entrypointInteractor: { getAssetConfig: async () => config },
      destinationEntrypointInteractor: { getAssetConfig: async () => config, getAddress: () => address(4) },
      swapChainAdapter: { isSameToken: (a,b) => a === b }, addressEqualityComparator: { equals: (a,b) => a === b },
      yieldTargetFor: () => undefined,
      assertDestinationChainMatches: () => {}, assertDestinationAcceptsCalls: async () => {}, assertFeeWithinBounds: () => {}, assertSwapQuoteMatchesRequest: () => {},
      relayerInteractor: { getSwapQuote: async (...args) => { calls.push(['relayer',args]); return { feeAmount: '0' }; } },
      swapQuoteProvider: { getSwapQuote: async (...args) => { calls.push(['plain',args]); return { toAmount: '900', toAmountMin: '800', feeCosts: fee(99) }; } },
      probeDestinationGuarantee: async (...args) => {
        calls.push(['probe',args]); probes++;
        return { budget: 700n, transactionValue: mode === 'plain' ? '0x0' : mode === 'native' ? (probes === 1 ? '1200' : '985') : (probes === 1 ? '100' : '96'), fromAmount: mode === 'native' ? (probes === 1 ? '990' : '786') : (probes === 1 ? '1000' : '990'), transactionTo: address(5), approvalAddress: address(6), feeCosts: fee(probes) };
      },
      sizeB2GasSwap: async (...args) => { calls.push(['gas',args]); return { gasSwapInput: 10n, swapValue: 120n, gasSwapMaxInput: 12n, gasSwapCalldata: '0x1234', feeCosts: fee(3) }; },
    });
    const result = await session.estimateReshieldCrosschainAmount({ relayerInfo: { chainId: 1, processorAddress: address(3), address: address(7) }, amount: '0x3e8', tokenId: mode === 'native' ? native : address(1), outputToken: address(2), toChainId: 10, toChainType: 'evm', fallbackAddress: address(8), slippage: 0.005 });
    return { result, calls, logs };
  }
  const old = await run(baseline), next = await run(patched);
  expect(next.calls).toEqual(old.calls);
  expect(next.logs).toEqual(old.logs);
  expect(withoutFees(next.result)).toEqual(withoutFees(old.result));
  expect(next.result.feeCosts).toEqual(mode === 'plain' ? fee(1) : mode === 'native' ? fee(2) : [...fee(2), ...fee(3)]);
});
