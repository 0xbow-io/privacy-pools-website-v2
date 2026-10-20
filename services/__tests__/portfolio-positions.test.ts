// Portfolio aggregation (codex P1: the page ran a second balance model —
// phantom positions from history, pending mixed into rows but not totals
// (150% allocation), ppUSDC shares as an ordinary 18-decimal pool).
//
// buildPortfolioPositions consumes the CANONICAL pools-provider figures
// (active = leaf-gated spendable; pending = everything else; spent notes
// and declined events never reach it) — these tests pin the derived model:
// active-only totals/positions, labeled pending, previewRedeem-valued yield
// under the underlying, and no ordinary withdraw for share rows.

import { describe, expect, test } from 'bun:test';

import {
  buildPortfolioPositions,
  type PortfolioSourcePool,
  type PortfolioYieldSource,
} from '@/services/portfolio-positions';

const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const USDC = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238';
const PPUSDC = '0x5555555555555555555555555555555555555555';
const PPUSDT = '0x7777777777777777777777777777777777777777';

const PRICES: Record<string, number> = { [ETH]: 2000, ETH: 2000, USDC: 1, USDT: 1 };
const priceFor = (address: string, symbol: string) =>
  PRICES[address.toLowerCase()] || PRICES[symbol] || 0;

function pool(overrides: Partial<PortfolioSourcePool>): PortfolioSourcePool {
  return { symbol: 'ETH', tokenAddress: ETH, activeBalance: 0, pendingBalance: 0, ...overrides };
}

function yieldSource(overrides: Partial<PortfolioYieldSource> = {}): PortfolioYieldSource {
  return {
    underlyingSymbol: 'USDC',
    shareSymbol: 'ppUSDC',
    ppUSDCAddress: PPUSDC,
    redeemableUnderlying: 104.21,
    hasShares: true,
    pendingShares: 0n,
    ppUSDCDecimals: 6,
    valueLoading: false,
    valueError: false,
    ...overrides,
  };
}

describe('active vs pending (the 150% allocation bug)', () => {
  test('Net Value counts ACTIVE only; pending is carried separately, never in the row value', () => {
    // $100 active + $50 pending ETH-equivalent: row = $100, total = $100,
    // pending = $50 — never a $150 row against a $100 denominator.
    const { positions, totalValueUsd, pendingValueUsd } = buildPortfolioPositions({
      pools: [pool({ activeBalance: 0.05, pendingBalance: 0.025 })], // $100 + $50
      priceFor,
    });
    expect(positions).toHaveLength(1);
    expect(positions[0].activeValueUsd).toBeCloseTo(100);
    expect(positions[0].activeBalance).toBeCloseTo(0.05);
    expect(positions[0].pendingBalance).toBeCloseTo(0.025);
    expect(totalValueUsd).toBeCloseTo(100);
    expect(pendingValueUsd).toBeCloseTo(50);
    // Allocation = active/total = 100%.
    expect(positions[0].activeValueUsd / totalValueUsd).toBeCloseTo(1);
  });

  test('pending-only funds are NOT a position (no phantom Withdraw), but count into pending', () => {
    const { positions, totalValueUsd, pendingValueUsd, hasPositions } = buildPortfolioPositions({
      pools: [pool({ activeBalance: 0, pendingBalance: 0.025 })],
      priceFor,
    });
    expect(positions).toHaveLength(0);
    expect(hasPositions).toBe(false);
    expect(totalValueUsd).toBe(0);
    expect(pendingValueUsd).toBeCloseTo(50);
  });

  test('a fully spent wallet (no active, no pending) has no positions', () => {
    // The canonical source never resurrects spent deposits — an empty pools
    // input stays empty (the old history-reconstruction fallback is gone).
    const out = buildPortfolioPositions({ pools: [], priceFor });
    expect(out.positions).toHaveLength(0);
    expect(out.hasPositions).toBe(false);
    expect(out.totalValueUsd).toBe(0);
  });

  test('ordinary active rows keep the ordinary withdraw action', () => {
    const { positions } = buildPortfolioPositions({
      pools: [pool({ activeBalance: 1 })],
      priceFor,
    });
    expect(positions[0].withdrawEnabled).toBe(true);
    expect(positions[0].isYield).toBe(false);
  });
});

describe('ppUSDC yield classification (before generic aggregation)', () => {
  test('the ppUSDC pool row is filtered; shares appear under the underlying at previewRedeem value', () => {
    const { positions, totalValueUsd } = buildPortfolioPositions({
      pools: [
        pool({ activeBalance: 0.05 }), // $100 ETH
        // What the generic path would have made of ppUSDC notes: an
        // address-prefix symbol with fallback decimals and no price.
        pool({ symbol: '0X5555', tokenAddress: PPUSDC, activeBalance: 104.21 }),
      ],
      priceFor,
      yieldSources: [yieldSource()],
    });
    // No phantom '0X5555' row.
    expect(positions.some((p) => p.tokenSymbol === '0X5555')).toBe(false);
    const yield_ = positions.find((p) => p.isYield);
    expect(yield_?.tokenSymbol).toBe('USDC');
    expect(yield_?.activeBalance).toBeCloseTo(104.21);
    expect(yield_?.activeValueUsd).toBeCloseTo(104.21); // USDC at $1
    // Net Value includes principal + accrued (previewRedeem), no double count.
    expect(totalValueUsd).toBeCloseTo(204.21);
  });

  test('yield rows expose the ordinary share-token withdraw action', () => {
    const { positions } = buildPortfolioPositions({
      pools: [],
      priceFor,
      yieldSources: [yieldSource()],
    });
    expect(positions[0].isYield).toBe(true);
    expect(positions[0].shareSymbol).toBe('ppUSDC');
    expect(positions[0].withdrawEnabled).toBe(true);
  });

  test('EVERY vault on the chain is classified, not just the first (mainnet ppUSDC + ppUSDT)', () => {
    // The singular yieldSource filtered only the first share address, so
    // ppUSDT notes fell through to generic aggregation as an 18-decimal
    // phantom pool with no price — the bug the classification exists to
    // prevent, reintroduced the day mainnet got its second vault.
    const { positions, totalValueUsd } = buildPortfolioPositions({
      pools: [
        pool({ symbol: '0X5555', tokenAddress: PPUSDC, activeBalance: 104.21 }),
        pool({ symbol: '0X7777', tokenAddress: PPUSDT, activeBalance: 60 }),
      ],
      priceFor,
      yieldSources: [
        yieldSource(),
        yieldSource({
          underlyingSymbol: 'USDT',
          shareSymbol: 'ppUSDT',
          ppUSDCAddress: PPUSDT,
          redeemableUnderlying: 60.5,
        }),
      ],
    });
    expect(positions.some((p) => p.tokenSymbol.startsWith('0X'))).toBe(false);
    expect(positions.map((p) => p.tokenSymbol).sort()).toEqual(['USDC', 'USDT']);
    expect(positions.find((p) => p.tokenSymbol === 'USDT')?.shareSymbol).toBe('ppUSDT');
    expect(totalValueUsd).toBeCloseTo(164.71);
  });

  test('plain underlying notes and yield shares coexist without double counting', () => {
    const { positions, totalValueUsd } = buildPortfolioPositions({
      pools: [pool({ symbol: 'USDC', tokenAddress: USDC, activeBalance: 50 })],
      priceFor,
      yieldSources: [yieldSource({ redeemableUnderlying: 100 })],
    });
    expect(positions).toHaveLength(2);
    expect(totalValueUsd).toBeCloseTo(150);
  });

  test('previewRedeem loading/error → value unavailable, not $0 counted as truth', () => {
    for (const s of [{ valueLoading: true }, { valueError: true }]) {
      const { positions, totalValueUsd, hasPositions } = buildPortfolioPositions({
        pools: [],
        priceFor,
        yieldSources: [yieldSource(s)],
      });
      expect(positions[0].valueUnavailable).toBe(true);
      expect(positions[0].activeValueUsd).toBe(0);
      expect(totalValueUsd).toBe(0);
      // Shares are still owned — the position exists.
      expect(hasPositions).toBe(true);
    }
  });

  test('pending-only shares are a distinct pending state, never a withdrawable position', () => {
    const { positions, hasPositions } = buildPortfolioPositions({
      pools: [],
      priceFor,
      yieldSources: [yieldSource({ hasShares: false, redeemableUnderlying: 0, pendingShares: 5_000_000n })],
    });
    expect(positions).toHaveLength(1);
    expect(positions[0].withdrawEnabled).toBe(false);
    expect(positions[0].pendingValueUnavailable).toBe(true);
    expect(hasPositions).toBe(false);
  });

  test('active shares carry their pending-share state on the row', () => {
    const { positions } = buildPortfolioPositions({
      pools: [],
      priceFor,
      yieldSources: [yieldSource({ pendingShares: 5_000_000n })],
    });
    expect(positions[0].pendingShares).toBe(5_000_000n);
  });
});

describe('price fallbacks', () => {
  test('stable fallback is the caller-provided priceFor concern; unknown tokens value at 0, not NaN', () => {
    const { positions, totalValueUsd } = buildPortfolioPositions({
      pools: [pool({ symbol: 'WEIRD', tokenAddress: '0xdead000000000000000000000000000000000000', activeBalance: 3 })],
      priceFor,
    });
    expect(positions[0].activeValueUsd).toBe(0);
    expect(Number.isNaN(totalValueUsd)).toBe(false);
  });
});

describe('configured cross-chain shares and canonical pending balances', () => {
  const ppEth = '0x8888888888888888888888888888888888888888';
  const source = yieldSource({ chainId: 1, underlyingSymbol: 'WETH', shareSymbol: 'ppETH', ppUSDCAddress: ppEth, ppUSDCDecimals: 18, underlyingPerShare: 1.01 });
  test('active and pending ETH shares value independently; legacy ETH stays separate', () => {
    const out = buildPortfolioPositions({
      pools: [pool({ chainId: 1, activeBalance: 1 }), pool({ chainId: 1, symbol: 'ppETH', tokenAddress: ppEth, activeBalance: 2, pendingBalance: 0.5 })],
      yieldSources: [source], priceFor,
    });
    expect(out.positions).toHaveLength(2);
    expect(out.totalValueUsd).toBeCloseTo(6040);
    expect(out.pendingValueUsd).toBeCloseTo(1010);
    expect(out.positions[1]).toMatchObject({ chainId: 1, tokenSymbol: 'ETH', shareSymbol: 'ppETH', pendingBalance: 0.505, withdrawEnabled: true });
  });
  test('pending-only canonical shares stay visible even if raw notes claim active shares', () => {
    const out = buildPortfolioPositions({ pools: [pool({ chainId: 1, symbol: 'ppETH', tokenAddress: ppEth, pendingBalance: 0.5 })], yieldSources: [source], priceFor });
    expect(out.positions).toHaveLength(1);
    expect(out.positions[0].withdrawEnabled).toBe(false);
    expect(out.totalValueUsd).toBe(0);
    expect(out.pendingValueUsd).toBeCloseTo(1010);
    expect(out.hasPositions).toBe(false);
  });
  test('missing rate retains configured identity with unknown active and pending values', () => {
    const out = buildPortfolioPositions({ pools: [pool({ chainId: 1, symbol: 'ppETH', tokenAddress: ppEth, activeBalance: 2, pendingBalance: 0.5 })], yieldSources: [{ ...source, underlyingPerShare: undefined, valueError: true }], priceFor });
    expect(out.positions[0]).toMatchObject({ tokenSymbol: 'ETH', isYield: true, valueUnavailable: true, pendingValueUnavailable: true });
    expect(out.pendingValueUnavailable).toBe(true);
    expect(out.totalValueUsd).toBe(0);
  });
  test('same address on another chain is not classified or priced by this deployment', () => {
    const out = buildPortfolioPositions({ pools: [pool({ chainId: 10, symbol: 'USDC', tokenAddress: ppEth, activeBalance: 3 }), pool({ chainId: 1, symbol: 'ppETH', tokenAddress: ppEth, activeBalance: 2 })], yieldSources: [source], priceFor: (address, symbol, chain) => chain === 1 ? priceFor(address, symbol) : 1 });
    expect(out.positions.find((p) => p.chainId === 10)?.isYield).toBe(false);
    expect(out.totalValueUsd).toBeCloseTo(4043);
  });
});
