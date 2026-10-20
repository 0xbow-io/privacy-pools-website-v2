import { describe, expect, test } from 'bun:test';
import {
  convertShares,
  interpolateAssetsPerShare,
  rateGridBlocks,
  readShareRateSeries,
  shareConversionAt,
  shareValueLabel,
  type RateHistoryClient,
  type RatePoint,
  type ShareRateSeries,
} from '@/services/share-rate-history';
import type { ShareDeploymentRef } from '@/services/share-rates';

const PPUSDT: ShareDeploymentRef = {
  chainId: 56,
  share: '0x6c17be9c864254ca4b2d36223f31ade94b4d64c2',
  underlying: '0x55d398326f99059ff775485246999027b3197955',
  shareSymbol: 'ppUSDT',
  shareDecimals: 18,
  underlyingSymbol: 'USDT',
  underlyingDecimals: 18,
};
const PPETH: ShareDeploymentRef = { ...PPUSDT, share: '0x00000000000000000000000000000000000000e7', shareSymbol: 'ppETH', underlyingSymbol: 'WETH' };

const E18 = 10n ** 18n;
const point = (block: bigint, timestampSec: number, assetsPerShare: bigint): RatePoint => ({ block, timestampSec, assetsPerShare });

const series: ShareRateSeries = {
  ref: PPUSDT,
  history: [point(1000n, 10_000, E18), point(2000n, 20_000, E18 + 2n * 10n ** 15n)],
  current: point(3000n, 30_000, E18 + 4n * 10n ** 15n),
};

describe('rate grid', () => {
  test('is aligned to a power-of-two step and capped', () => {
    const blocks = rateGridBlocks(1_000n, 100_000n, 64);
    expect(blocks.length).toBeLessThanOrEqual(64);
    const step = blocks[1] - blocks[0];
    expect(step & (step - 1n)).toBe(0n);
    expect(blocks.every((b) => b % step === 0n && b >= 1_000n && b < 100_000n)).toBe(true);
  });

  test('does not depend on anything but the start block and the head', () => {
    expect(rateGridBlocks(1_000n, 100_000n)).toEqual(rateGridBlocks(1_000n, 100_000n));
    const earlier = rateGridBlocks(1_000n, 100_000n);
    expect(rateGridBlocks(1_000n, 100_050n).slice(0, earlier.length)).toEqual(earlier);
    expect(rateGridBlocks(5n, 5n)).toEqual([]);
  });
});

describe('interpolation', () => {
  const pts = [...series.history, series.current!];

  test('by time and by block land on the same rate', () => {
    const mid = E18 + 10n ** 15n;
    expect(interpolateAssetsPerShare(pts, { timestampSec: 15_000 })).toBe(mid);
    expect(interpolateAssetsPerShare(pts, { block: 1500n })).toBe(mid);
  });

  test('does not extrapolate before or after the read range by time or block', () => {
    for (const at of [{ timestampSec: 9_999 }, { timestampSec: 30_001 }, { block: 999n }, { block: 3001n }]) {
      expect(interpolateAssetsPerShare(pts, at)).toBeNull();
    }
  });

  test('exact endpoints retain their sampled rates by time and block', () => {
    for (const p of [pts[0], pts[pts.length - 1]]) {
      expect(interpolateAssetsPerShare(pts, { timestampSec: p.timestampSec })).toBe(p.assetsPerShare);
      expect(interpolateAssetsPerShare(pts, { block: p.block })).toBe(p.assetsPerShare);
    }
  });

  test('a single point covers only its exact coordinate by time or block', () => {
    const p = pts[0];
    expect(interpolateAssetsPerShare([p], { timestampSec: p.timestampSec })).toBe(p.assetsPerShare);
    expect(interpolateAssetsPerShare([p], { block: p.block })).toBe(p.assetsPerShare);
    for (const at of [
      { timestampSec: p.timestampSec - 1 }, { timestampSec: p.timestampSec + 1 },
      { block: p.block - 1n }, { block: p.block + 1n },
    ]) expect(interpolateAssetsPerShare([p], at)).toBeNull();
  });

  test('needs a position', () => {
    expect(interpolateAssetsPerShare(pts, {})).toBeNull();
  });
});

describe('conversion at the transaction', () => {
  test('uses the past rate and names the underlying', () => {
    const c = shareConversionAt(series, { timestampSec: 20_000 })!;
    expect(c.atTx).toBe(true);
    expect(c.symbol).toBe('USDT');
    expect(convertShares(c, 10n * E18)).toBe(10n * E18 + 2n * 10n ** 16n);
    expect(shareValueLabel(c, 10n * E18)).toBe('10.02 USDT (at transaction time)');
  });

  test('falls back to the current rate when no past rate was readable', () => {
    const c = shareConversionAt({ ...series, history: [] }, { timestampSec: 15_000 })!;
    expect(c.atTx).toBe(false);
    expect(c.assetsPerShare).toBe(series.current!.assetsPerShare);
    expect(shareValueLabel(c, 10n * E18)).toBe('≈ 10.04 USDT');
  });

  test('positions outside coverage use an explicitly approximate current rate', () => {
    for (const at of [{ timestampSec: 9_999 }, { timestampSec: 30_001 }, { block: 999n }, { block: 3001n }]) {
      const c = shareConversionAt(series, at)!;
      expect(c.atTx).toBe(false);
      expect(c.assetsPerShare).toBe(series.current!.assetsPerShare);
      expect(shareValueLabel(c, 10n * E18)).toBe('≈ 10.04 USDT');
    }
  });

  test('positions outside coverage have no conversion without a current rate', () => {
    for (const at of [{ timestampSec: 9_999 }, { timestampSec: 20_001 }, { block: 999n }, { block: 2001n }]) {
      expect(shareConversionAt({ ...series, current: null }, at)).toBeNull();
    }
  });

  test('exact coverage boundaries remain historical by time and block', () => {
    for (const p of [series.history[0], series.current!]) {
      for (const at of [{ timestampSec: p.timestampSec }, { block: p.block }]) {
        const c = shareConversionAt(series, at)!;
        expect(c.atTx).toBe(true);
        expect(c.assetsPerShare).toBe(p.assetsPerShare);
      }
    }
  });

  test('falls back to the current rate when the transaction has no position', () => {
    expect(shareConversionAt(series, { timestampSec: null })!.atTx).toBe(false);
    expect(shareConversionAt(series, null)!.atTx).toBe(false);
  });

  test('is null with no rate at all', () => {
    expect(shareConversionAt({ ref: PPUSDT, history: [], current: null }, { timestampSec: 1 })).toBeNull();
  });

  test('a WETH vault reads as ETH', () => {
    expect(shareConversionAt({ ...series, ref: PPETH }, null)!.symbol).toBe('ETH');
  });
});

describe('reading the series', () => {
  test('one multicall per grid block covers every share and skips failed blocks', async () => {
    const calls: bigint[] = [];
    const client: RateHistoryClient = {
      getBlockNumber: async () => 4_000n,
      multicall: async ({ blockNumber, contracts }) => {
        calls.push(blockNumber);
        expect(contracts.length).toBe(3);
        if (blockNumber < 2_000n) throw new Error('missing trie node');
        return [
          { status: 'success', result: E18 + blockNumber },
          { status: 'failure', error: new Error('no code') },
          { status: 'success', result: blockNumber * 10n },
        ];
      },
    };
    const [usdt, eth] = await readShareRateSeries(client, [PPUSDT, PPETH], 1_000n);
    expect(new Set(calls).size).toBe(calls.length);
    expect(calls).toContain(4_000n);
    expect(calls.length).toBeLessThanOrEqual(65);
    expect(usdt.current).toEqual(point(4_000n, 40_000, E18 + 4_000n));
    expect(usdt.history.length).toBeGreaterThan(0);
    expect(usdt.history.every((p) => p.block >= 2_000n && p.block < 4_000n)).toBe(true);
    expect(usdt.history.map((p) => p.block)).toEqual([...usdt.history.map((p) => p.block)].sort((a, b) => (a < b ? -1 : 1)));
    expect(eth.history).toEqual([]);
    expect(eth.current).toBeNull();
    const first = usdt.history[0];
    for (const at of [{ block: first.block - 1n }, { timestampSec: first.timestampSec - 1 }]) {
      const c = shareConversionAt(usdt, at)!;
      expect(c.atTx).toBe(false);
      expect(c.assetsPerShare).toBe(usdt.current!.assetsPerShare);
      expect(shareConversionAt({ ...usdt, current: null }, at)).toBeNull();
    }
  });

  test('an endpoint without past state still yields the current rate', async () => {
    const client: RateHistoryClient = {
      getBlockNumber: async () => 4_000n,
      multicall: async ({ blockNumber }) => {
        if (blockNumber !== 4_000n) throw new Error('missing trie node');
        return [{ status: 'success', result: E18 }, { status: 'success', result: 1n }];
      },
    };
    const [usdt] = await readShareRateSeries(client, [PPUSDT], 1_000n);
    expect(usdt.history).toEqual([]);
    expect(shareConversionAt(usdt, { timestampSec: 1 })).toMatchObject({ assetsPerShare: E18, atTx: false });
  });
});
