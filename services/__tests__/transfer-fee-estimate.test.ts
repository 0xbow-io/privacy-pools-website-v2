import { expect, test } from 'bun:test';
import { bestConsolidation, type ConsolidatableNote } from '../consolidate-notes';
import type { FeedState } from '../public-feed-scheduler';
import {
  estimateTransferFee,
  GAS_PRICE_INTERVAL_MS,
  readGasPrice,
  usdPriceOf,
} from '../transfer-fee-estimate';

const BNB = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const native = { decimals: 18, usd: null };
const nativeAsset = { decimals: 18, isNative: true, usd: null };

let seq = 0;
const note = (value: bigint, label: string): ConsolidatableNote => ({
  commitment: `0x${(++seq).toString(16).padStart(64, '0')}`, label, tokenId: BNB, value: value.toString(), status: 'ACTIVE',
});

test('reproduces the relayer fee charged for a prod BNB transfer', () => {
  // BSC at 0.05 gwei: 0.05 gwei × 850k gas + 21000 wei. The relayed transfer on
  // prod cost 0.0000425 BNB, and Send displayed "~0.000043 BNB".
  const fee = estimateTransferFee(50_000_000n, native, nativeAsset);
  expect(fee).toBe(42_500_000_021_000n);
});

test('converts the gas cost into a non-native asset at the price ratio, rounding up', () => {
  // 1 gwei × 850k = 0.00085 ETH; at $2000/ETH that is $1.70 of 6-decimal USDC.
  expect(estimateTransferFee(1_000_000_000n, { decimals: 18, usd: 2000 }, { decimals: 6, isNative: false, usd: 1 }))
    .toBe(1_721_000n);
  // An 18-decimal share worth $1.02: never below the exact figure.
  const share = estimateTransferFee(1_000_000_000n, { decimals: 18, usd: 2000 }, { decimals: 18, isNative: false, usd: 1.02 })!;
  // $1.70 / $1.02 plus 21000 base units, with <1000 wei conversion rounding.
  expect(share).toBeGreaterThanOrEqual(1_666_666_666_666_687_667n);
  expect(share).toBeLessThan(1_666_666_666_666_688_667n);
});

test('an unpriceable fee is unknown rather than zero', () => {
  expect(estimateTransferFee(null, native, nativeAsset)).toBeNull();
  expect(estimateTransferFee(-1n, native, nativeAsset)).toBeNull();
  for (const [nativeUsd, assetUsd] of [[null, 1], [2000, null], [0, 1], [2000, 0], [Number.NaN, 1], [2000, Number.POSITIVE_INFINITY], [1e308, 1e-308], [1e-308, 1e308]]) {
    expect(estimateTransferFee(1n, { decimals: 18, usd: nativeUsd }, { decimals: 6, isNative: false, usd: assetUsd })).toBeNull();
  }
});

test('gas price reads hide missing, failed and stale readings', () => {
  const ready: FeedState<bigint> = { status: 'ready', at: 100, data: 7n };
  expect(readGasPrice(ready, 101)).toBe(7n);
  expect(readGasPrice(ready, 100 + 2 * GAS_PRICE_INTERVAL_MS)).toBeNull();
  expect(readGasPrice({ status: 'empty' }, 101)).toBeNull();
  expect(readGasPrice({ status: 'error', at: 101, error: new Error('offline'), data: 7n, dataAt: 100 }, 102)).toBeNull();
});

test('prices resolve by address, then symbol, with stablecoins defaulting to $1', () => {
  expect(usdPriceOf({ '0xabc': 3 }, '0xABC', 'X', false)).toBe(3);
  expect(usdPriceOf({ BNB: 600 }, BNB, 'bnb', false)).toBe(600);
  expect(usdPriceOf({ cBTC: 60_000 }, BNB, 'cBTC', false)).toBe(60_000);
  expect(usdPriceOf({ '0xabc': 0 }, '0xabc', 'USDT', true)).toBe(1);
  expect(usdPriceOf(undefined, '0xabc', 'X', false)).toBeNull();
});

test('the reported BNB dust pair gets no prompt at the estimated fee; real small notes still do', () => {
  const fee = estimateTransferFee(50_000_000n, native, nativeAsset);
  expect(bestConsolidation([note(578_025_000_000n, 'dust'), note(400_000_000_000n, 'dust')], BNB, fee)).toBeNull();
  expect(bestConsolidation([note(4_000_000_000_000_000n, 'a'), note(4_000_000_000_000_000n, 'a')], BNB, fee)?.notes).toHaveLength(2);
  expect(bestConsolidation([1, 2, 3].map(() => note(5_000_000_000_000_000n, 'b')), BNB, fee)?.notes).toHaveLength(3);
  // No gas price yet: no prompt.
  expect(bestConsolidation([note(4_000_000_000_000_000n, 'c'), note(4_000_000_000_000_000n, 'c')], BNB, null)).toBeNull();
});

