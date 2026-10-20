import { describe, expect, test } from 'bun:test';
import { assetStatsRowsForChain, foldRowsPerAsset } from '@/services/stats-asset-fold';

/**
 * The ASP's /:chainId/public/assets-stats returns ONE ROW PER POOL, so an asset
 * living in two pool eras comes back twice for the same chain+token with no
 * field distinguishing them. These are the REAL Sepolia ETH rows observed live
 * (99 deposits/$24,366 and 500/$341,291) — the shape that produced duplicate
 * cards and a duplicate React key before the fold.
 */
const ethPoolA = {
  asset: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  chainId: '11155111',
  tokenSymbol: 'ETH',
  tokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  totalDepositsValueUsd: '24366.02',
  totalDepositsValue: '12571600000000002000',
  totalDepositsCount: 99,
  acceptedDepositsValueUsd: '24366.02',
  acceptedDepositsValue: '12571600000000002000',
  acceptedDepositsCount: 99,
  totalInAssetValueUsd: '22685.77',
  totalInAssetValue: '11704677826937613902',
  pendingDepositsValueUsd: '1.94',
  pendingDepositsValue: '1000000000002000',
  pendingDepositsCount: 3,
  growth24h: null,
} as never;

const ethPoolB = {
  ...(ethPoolA as object),
  totalDepositsValueUsd: '341291.97',
  totalDepositsValue: '176088892000000001000',
  totalDepositsCount: 500,
  acceptedDepositsValueUsd: '341291.97',
  acceptedDepositsValue: '176088892000000001000',
  acceptedDepositsCount: 500,
  totalInAssetValueUsd: '334369.97',
  totalInAssetValue: '172517502909576668553',
  pendingDepositsValueUsd: '3.88',
  pendingDepositsValue: '2000000000000000',
  pendingDepositsCount: 2,
} as never;

describe('foldRowsPerAsset. Collapses the ASP per-pool rows', () => {
  test('two pool rows for one asset fold into a single row', () => {
    const out = foldRowsPerAsset([ethPoolA, ethPoolB], 11155111);
    expect(out).toHaveLength(1);
  });

  test('counts and USD totals are summed across pools', () => {
    const [row] = foldRowsPerAsset([ethPoolA, ethPoolB], 11155111) as never as Record<string, unknown>[];
    expect(row.totalDepositsCount).toBe(599);          // 99 + 500
    expect(row.pendingDepositsCount).toBe(5);          // 3 + 2
    expect(Number(row.totalDepositsValueUsd)).toBeCloseTo(365657.99, 2);
    expect(Number(row.totalInAssetValueUsd)).toBeCloseTo(357055.74, 2);
  });

  test('base-unit amounts are summed as BigInt, not floats (wei-scale precision)', () => {
    const [row] = foldRowsPerAsset([ethPoolA, ethPoolB], 11155111) as never as Record<string, unknown>[];
    // 12571600000000002000 + 176088892000000001000 — the trailing ...2000/...1000
    // digits survive only under BigInt; Number() would round them away.
    expect(row.totalDepositsValue).toBe('188660492000000003000');
    expect(row.totalInAssetValue).toBe('184222180736514282455');
  });

  test('a single-pool asset passes through untouched', () => {
    const out = foldRowsPerAsset([ethPoolA], 11155111);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(ethPoolA);
  });

  test('different assets stay separate', () => {
    const usdc = { ...(ethPoolA as object), tokenAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' } as never;
    expect(foldRowsPerAsset([ethPoolA, usdc], 11155111)).toHaveLength(2);
  });

  test('growth24h survives only when the pools agree. Never averaged', () => {
    const a = { ...(ethPoolA as object), growth24h: 5 } as never;
    const bSame = { ...(ethPoolB as object), growth24h: 5 } as never;
    const bDiff = { ...(ethPoolB as object), growth24h: 9 } as never;
    const [agree] = foldRowsPerAsset([a, bSame], 11155111) as never as Record<string, unknown>[];
    const [differ] = foldRowsPerAsset([a, bDiff], 11155111) as never as Record<string, unknown>[];
    expect(agree.growth24h).toBe(5);
    expect(differ.growth24h).toBeNull();   // omitted rather than guessed
  });

  test('rows without a token address are dropped', () => {
    const nameless = { ...(ethPoolA as object), tokenAddress: '' } as never;
    expect(foldRowsPerAsset([nameless], 11155111)).toHaveLength(0);
  });
});


describe('all-chains rows used by the pool provider', () => {
  test('address collisions and unassigned chains cannot contaminate the selected chain', () => {
    const row = (chainId: string, value: string) => ({
      asset: 'native', chainId, tokenSymbol: 'ETH', tokenAddress: 'same-native-address',
      totalDepositsValueUsd: value, totalInAssetValueUsd: value,
      pendingDepositsValueUsd: '0', growth24h: null, pendingGrowth24h: null,
      totalDepositsCount: Number(value),
    });
    const selected = row('1', '5');
    const other = row('10', '900');
    const missing = { ...row('', '800'), chainId: undefined };
    const response = {
      assets: [selected, other, ...['0', '', 'NaN', '1oops', '-1'].map((id) => row(id, '800')), missing],
      cacheTimestamp: 'aggregate-assembly-time',
      totals: { totalDepositsValueUsd: '99999' },
    };
    // Malformed HTTP JSON is not protected by the TypeScript interface.
    const rows = assetStatsRowsForChain(response as Parameters<typeof assetStatsRowsForChain>[0], 1);
    expect(rows).toEqual([selected]);
    expect(rows[0]).toBe(selected);
    expect(assetStatsRowsForChain(response as Parameters<typeof assetStatsRowsForChain>[0], 10)).toEqual([other]);
    expect(assetStatsRowsForChain(undefined, 1)).toEqual([]);
    expect(response.assets).toHaveLength(8);
  });
});
