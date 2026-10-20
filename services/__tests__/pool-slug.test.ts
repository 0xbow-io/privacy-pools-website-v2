import { describe, expect, test } from 'bun:test';
import { hideEmptyBalanceRow, hideEmptyLegacyRow, isSupersededPlainPool, poolLabel, poolSlug, poolSymbolFromSlug, visibleSwapSources, type PoolSlugContext } from '../pool-slug';

// Mainnet after the ppETH launch: three share pools, plain ETH superseded by
// ppETH, plain USDC/USDT superseded by their shares (deposits wrap).
const MAINNET: PoolSlugContext = {
  shareSymbols: ['PPUSDC', 'PPUSDT', 'PPETH'],
  openPlainSymbols: [],
  legacyPlainSymbols: ['ETH', 'USDC', 'USDT'],
};
// A chain with a share AND a still-open plain pool of the same coin.
const OPEN_COLLISION: PoolSlugContext = {
  shareSymbols: ['PPUSDT'],
  openPlainSymbols: ['USDT', 'BNB'],
  legacyPlainSymbols: [],
};
// Sepolia staging: no shares at all.
const STAGING: PoolSlugContext = { shareSymbols: [], openPlainSymbols: ['ETH', 'USDC', 'USDT'], legacyPlainSymbols: [] };

describe('poolSlug', () => {
  test('the share takes the coin’s URL and the superseded plain pool moves to -legacy (Pat, 2026-09-18)', () => {
    expect(poolSlug('ppETH', MAINNET)).toBe('eth');
    expect(poolSlug('ETH', MAINNET)).toBe('eth-legacy');
    expect(poolSlug('ppUSDC', MAINNET)).toBe('usdc');
    expect(poolSlug('USDC', MAINNET)).toBe('usdc-legacy');
  });

  test('an open plain pool keeps its URL and the colliding share keeps its raw symbol', () => {
    expect(poolSlug('USDT', OPEN_COLLISION)).toBe('usdt');
    expect(poolSlug('ppUSDT', OPEN_COLLISION)).toBe('ppusdt');
    expect(poolSlug('BNB', OPEN_COLLISION)).toBe('bnb');
  });

  test('without shares nothing changes', () => {
    expect(poolSlug('ETH', STAGING)).toBe('eth');
    expect(poolSlug('USDC', STAGING)).toBe('usdc');
  });
});

describe('poolSymbolFromSlug', () => {
  test('round-trips every mainnet pool', () => {
    for (const symbol of ['PPETH', 'ETH', 'PPUSDC', 'USDC', 'PPUSDT', 'USDT']) {
      expect(poolSymbolFromSlug(poolSlug(symbol, MAINNET), MAINNET)).toBe(symbol);
    }
  });

  test('old links keep working: a raw share slug still names the share', () => {
    expect(poolSymbolFromSlug('ppeth', MAINNET)).toBe('PPETH');
    expect(poolSymbolFromSlug('PPUSDC', MAINNET)).toBe('PPUSDC');
  });

  test('on a chain with an open plain pool the coin’s slug is the plain pool', () => {
    expect(poolSymbolFromSlug('usdt', OPEN_COLLISION)).toBe('USDT');
    expect(poolSymbolFromSlug('ppusdt', OPEN_COLLISION)).toBe('PPUSDT');
  });

  test('a chain without the share resolves the coin to itself', () => {
    expect(poolSymbolFromSlug('eth', STAGING)).toBe('ETH');
    expect(poolSymbolFromSlug('cbtc', STAGING)).toBe('CBTC');
  });
});

describe('poolLabel', () => {
  test('the share reads as the coin; the superseded plain pool says so; no pp anywhere', () => {
    expect(poolLabel('ppETH', MAINNET)).toBe('ETH');
    expect(poolLabel('ETH', MAINNET)).toBe('ETH (legacy)');
    expect(poolLabel('ppUSDC', MAINNET)).toBe('USDC');
    for (const s of ['ppETH', 'ETH', 'ppUSDC', 'USDC', 'ppUSDT', 'USDT']) {
      expect(poolLabel(s, MAINNET)).not.toMatch(/\bpp/i);
    }
  });

  test('an open plain pool is just the coin', () => {
    expect(poolLabel('USDT', OPEN_COLLISION)).toBe('USDT');
    expect(poolLabel('ETH', STAGING)).toBe('ETH');
  });
});

describe('hideEmptyLegacyRow', () => {
  test('only an emptied legacy pool disappears', () => {
    expect(hideEmptyLegacyRow(0n, 0n, true)).toBe(true);
    expect(hideEmptyLegacyRow(1n, 0n, true)).toBe(false);
    expect(hideEmptyLegacyRow(0n, 1n, true)).toBe(false);
    expect(hideEmptyLegacyRow(0n, 0n, false)).toBe(false);
  });
});

describe('visibleSwapSources', () => {
  // The Swap tab's "You swap" chips on mainnet after the ppETH launch: plain
  // ETH is the superseded pool, and a user who emptied it has nothing to swap
  // from, so the chip must not be offered (it was, until 2026-09-21).
  const holdings: Record<string, { balanceRaw: bigint; pendingRaw: bigint; legacy: boolean }> = {
    ETH: { balanceRaw: 0n, pendingRaw: 0n, legacy: true },
    BNB: { balanceRaw: 0n, pendingRaw: 0n, legacy: false },
  };
  const tokens = [{ symbol: 'ETH' }, { symbol: 'BNB' }];
  const held = (t: { symbol: string }) => holdings[t.symbol];

  test('an emptied legacy source is dropped; the same one funded is offered', () => {
    expect(visibleSwapSources(tokens, held).map((t) => t.symbol)).toEqual(['BNB']);
    expect(visibleSwapSources([{ symbol: 'ETH' }], (t) => ({ ...held(t), balanceRaw: 1n })))
      .toEqual([{ symbol: 'ETH' }]);
    // A note still settling is a balance for this purpose.
    expect(visibleSwapSources([{ symbol: 'ETH' }], (t) => ({ ...held(t), pendingRaw: 1n })))
      .toEqual([{ symbol: 'ETH' }]);
  });

  test('an open pool is offered whether or not it is funded', () => {
    expect(visibleSwapSources([{ symbol: 'BNB' }], held)).toEqual([{ symbol: 'BNB' }]);
  });
});

describe('isSupersededPlainPool', () => {
  test('the plain pool a share replaced is superseded; the share, an open plain pool and a chain without shares are not', () => {
    expect(isSupersededPlainPool('ETH', MAINNET)).toBe(true);
    expect(isSupersededPlainPool('eth', MAINNET)).toBe(true);
    expect(isSupersededPlainPool('ppETH', MAINNET)).toBe(false);
    expect(isSupersededPlainPool('USDT', OPEN_COLLISION)).toBe(false);
    expect(isSupersededPlainPool('ETH', STAGING)).toBe(false);
  });

  test('a legacy plain pool with NO share of its own name stays listed', () => {
    const ctx: PoolSlugContext = { shareSymbols: ['PPUSDC'], openPlainSymbols: [], legacyPlainSymbols: ['CBTC', 'USDC'] };
    expect(isSupersededPlainPool('CBTC', ctx)).toBe(false);
    expect(isSupersededPlainPool('USDC', ctx)).toBe(true);
  });
});

describe('hideEmptyBalanceRow (DEV-466)', () => {
  test('an emptied pool of any kind is hidden', () => {
    expect(hideEmptyBalanceRow(0n, 0n, false)).toBe(true);
  });
  test('dust, pending or an at-risk note keeps the row', () => {
    expect(hideEmptyBalanceRow(1n, 0n, false)).toBe(false);
    expect(hideEmptyBalanceRow(0n, 1n, false)).toBe(false);
    expect(hideEmptyBalanceRow(0n, 0n, true)).toBe(false);
  });
});
