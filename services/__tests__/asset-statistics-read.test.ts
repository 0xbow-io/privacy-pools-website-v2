import { describe, expect, test } from 'bun:test';
import type { AllAssetStatisticsResponse, AssetStatistics } from '@/services/api-types';
import { pickAssetStatistics, readAssetStatistics, type AssetStatisticsSource } from '@/services/asset-statistics-read';

// The grid reads every catalogued asset's statistics in one request that names
// no asset (asp-v2#252), and takes this build's pool's entry for each. An ASP
// that predates the list is asked per asset, as before.

const POOL = '0xeb3e3961008952348445513e418ad6f43c23ca9a';
const OTHER_POOL = '0x3191ed61bc961667f368600caf147f08cffa2559';
const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const USDT = '0xaa8e23fb1079ea71e0a56f48a2aa51851d8433d0';
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';

function stats(asset: string, entrypoint: string, deposits: number): AssetStatistics & { entrypoint: string } {
  const window = {
    tvl: '1', tvlUsd: '1', avgDepositSize: '1', avgDepositSizeUsd: '1',
    totalDepositsCount: deposits, totalDepositsValue: '1', totalDepositsValueUsd: '1',
    totalWithdrawalsCount: 0, totalWithdrawalsValue: '0', totalWithdrawalsValueUsd: '0',
  };
  return { asset, chainId: '11155111', entrypoint, tokenSymbol: 'T', tokenAddress: asset, allTime: window, last24h: window };
}

function source(list: AllAssetStatisticsResponse | number, perAsset: Record<string, AssetStatistics | number> = {}) {
  const sent: string[] = [];
  const fail = (status: number) => Object.assign(new Error(`API request failed: ${status}`), { statusCode: status });
  const asp: AssetStatisticsSource = {
    tokens: () => [{ address: ETH.toUpperCase().replace('0X', '0x') }, { address: USDC }, { address: USDT }, { address: DAI }],
    entrypoint: async () => POOL.toUpperCase().replace('0X', '0x'),
    all: async () => {
      sent.push('all');
      if (typeof list === 'number') throw fail(list);
      return list;
    },
    one: async (_chain, token) => {
      sent.push(token.toLowerCase());
      const answer = perAsset[token.toLowerCase()] ?? 404;
      if (typeof answer === 'number') throw fail(answer);
      return { asset: answer, cacheTimestamp: 't' };
    },
  };
  return { asp, sent };
}

describe('asset statistics feed', () => {
  test('reads the list once and takes this build pool entry for each token', async () => {
    const { asp, sent } = source({
      assets: [
        stats(USDC, POOL, 185), stats(USDC, OTHER_POOL, 28),
        stats(ETH, OTHER_POOL, 562), stats(ETH, POOL, 5105),
        stats(USDT, OTHER_POOL, 4), stats(USDT, '0x01', 5),
      ],
      cacheTimestamp: 'oldest',
    }, { [USDT]: stats(USDT, OTHER_POOL, 6), [DAI]: stats(DAI, POOL, 7) });
    const feed = await readAssetStatistics(11155111, asp, {});
    expect(feed[ETH]?.allTime.totalDepositsCount).toBe(5105);
    expect(feed[USDC]?.allTime.totalDepositsCount).toBe(185);
    // A token several other pools hold, and one the list leaves out (the list
    // holds enabled assets only, and the ASP serves a disabled one per asset),
    // are asked for alone, and their answers are kept.
    expect(sent).toEqual(['all', USDT, DAI]);
    expect(feed[USDT]?.allTime.totalDepositsCount).toBe(6);
    expect(feed[DAI]?.allTime.totalDepositsCount).toBe(7);
  });

  test('an ASP without the list is asked per asset', async () => {
    const { asp, sent } = source(404, { [USDC]: stats(USDC, POOL, 7) });
    const feed = await readAssetStatistics(11155111, asp, {});
    expect(sent).toEqual(['all', ETH, USDC, USDT, DAI]);
    expect(feed[USDC]?.allTime.totalDepositsCount).toBe(7);
    expect(feed[ETH]).toBeNull();
  });

  test('a per-asset read that fails keeps the previous figures', async () => {
    const previous = { [USDC]: stats(USDC, POOL, 3) };
    const { asp } = source(404, { [ETH]: stats(ETH, POOL, 9), [USDC]: 502 });
    const feed = await readAssetStatistics(11155111, asp, previous);
    expect(feed[USDC]?.allTime.totalDepositsCount).toBe(3);
    expect(feed[ETH]?.allTime.totalDepositsCount).toBe(9);
  });

  test('a list read that fails otherwise fails the tick', async () => {
    const { asp, sent } = source(503);
    await expect(readAssetStatistics(11155111, asp, {})).rejects.toThrow('503');
    expect(sent).toEqual(['all']);
  });

  test('picks the only pool, or leaves an unlisted token or several pools none of which is ours to the per-asset read', () => {
    const list = { assets: [stats(USDC, OTHER_POOL, 1), stats(USDT, OTHER_POOL, 2), stats(USDT, '0x01', 3)], cacheTimestamp: 't' };
    expect(pickAssetStatistics(list, USDC, POOL)?.allTime.totalDepositsCount).toBe(1);
    expect(pickAssetStatistics(list, USDT, POOL)).toBeUndefined();
    expect(pickAssetStatistics(list, ETH, POOL)).toBeUndefined();
    expect(pickAssetStatistics(list, USDT.toUpperCase().replace('0X', '0x'), '0x01')?.allTime.totalDepositsCount).toBe(3);
  });
});
