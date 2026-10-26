import { describe, expect, test } from 'bun:test';

import {
  EXPLORE_POOLS_COLLAPSED_ROWS,
  EXPLORE_POOLS_PAGE_SIZE,
  applyChainFilter,
  filterRowsToChains,
  formatCompactTokenAmount,
  formatPoolTokenAmount,
  poolChainFilterOptions,
  poolTableChains,
  poolsWindow,
  showMoreLabel,
  sortPoolsByTvl,
  type PoolChain,
} from '../explore-pools';

// A staging-shaped line-up: mainnet + Citrea + Optimism + Sepolia + Sui, the
// five chains EXPO_PUBLIC_STAGING enables. The public build is the [SEPOLIA,
// SUI] subset, exercised in its own cases below.
const MAINNET: PoolChain = { id: 1, label: 'Ethereum', chainType: 'evm' };
const CITREA: PoolChain = { id: 4114, label: 'Citrea', chainType: 'evm' };
const OPTIMISM: PoolChain = { id: 10, label: 'Optimism', chainType: 'evm' };
const SEPOLIA: PoolChain = { id: 11155111, label: 'Sepolia', chainType: 'evm' };
const SUI: PoolChain = { id: 102, label: 'Sui Testnet', chainType: 'sui' };
const STAGING = [MAINNET, CITREA, OPTIMISM, SEPOLIA, SUI];

function row(chainId: number, tvlUsd: number | null, key = `${chainId}:t`) {
  return { chainId, tvlUsd, key };
}

describe('poolTableChains', () => {
  test('covers every EVM chain the build enables, not just the active one', () => {
    const chains = poolTableChains({ supported: STAGING, activeChainId: 4114, isDebugEnabled: false });
    expect(chains.map((c) => c.id)).toEqual([1, 4114, 10, 11155111]);
  });

  test('a smaller build gets a smaller scope, with no hardcoded chain list', () => {
    const chains = poolTableChains({
      supported: [SEPOLIA, SUI],
      activeChainId: 11155111,
      isDebugEnabled: false,
    });
    expect(chains.map((c) => c.id)).toEqual([11155111]);
  });

  test('Sui appears for a debug viewer', () => {
    const chains = poolTableChains({ supported: STAGING, activeChainId: 1, isDebugEnabled: true });
    expect(chains.map((c) => c.id)).toContain(102);
  });

  test('Sui appears for a viewer standing on it, debug or not', () => {
    // Otherwise selecting Sui would empty the very table that used to be its
    // only home.
    const chains = poolTableChains({ supported: STAGING, activeChainId: 102, isDebugEnabled: false });
    expect(chains.map((c) => c.id)).toContain(102);
  });
});

describe('filterRowsToChains', () => {
  test('drops rows on chains this build does not serve', () => {
    // The ASP's /all feed answers for BSC (56); no build here enables it.
    const rows = [row(1, 10), row(56, 99), row(11155111, 5)];
    const kept = filterRowsToChains(rows, (r) => r.chainId, [1, 11155111]);
    expect(kept.map((r) => r.chainId)).toEqual([1, 11155111]);
  });

  test('drops a row whose chain id the feed left unusable', () => {
    const rows = [{ chainId: null }, { chainId: 1 }];
    const kept = filterRowsToChains(rows, (r) => r.chainId, [1]);
    expect(kept).toEqual([{ chainId: 1 }]);
  });
});

describe('poolChainFilterOptions', () => {
  test('offers only chains that actually have a pool', () => {
    const rows = [row(1, 10), row(11155111, 5), row(1, 3, '1:u')];
    expect(poolChainFilterOptions(rows, STAGING).map((c) => c.id)).toEqual([1, 11155111]);
  });

  test('keeps the build chain order, not the row order', () => {
    // Rows arrive richest-first, which changes on every refetch; the menu must
    // not reshuffle underneath a viewer reading it.
    const rows = [row(11155111, 90), row(10, 80), row(1, 70)];
    expect(poolChainFilterOptions(rows, STAGING).map((c) => c.id)).toEqual([1, 10, 11155111]);
  });
});

describe('applyChainFilter', () => {
  test('an empty selection means All', () => {
    const rows = [row(1, 10), row(10, 5)];
    expect(applyChainFilter(rows, new Set()).map((r) => r.chainId)).toEqual([1, 10]);
  });

  test('a selection keeps only those chains', () => {
    const rows = [row(1, 10), row(10, 5), row(11155111, 1)];
    expect(applyChainFilter(rows, new Set([10, 11155111])).map((r) => r.chainId)).toEqual([10, 11155111]);
  });
});

describe('sortPoolsByTvl', () => {
  test('richest pool first, across chains', () => {
    const rows = [row(1, 10, 'a'), row(10, 900, 'b'), row(11155111, 50, 'c')];
    expect(sortPoolsByTvl(rows).map((r) => r.key)).toEqual(['b', 'c', 'a']);
  });

  test('an unpublished TVL sinks below a genuinely empty pool', () => {
    // null is "the ASP did not say", which must not outrank a real $0.
    const rows = [row(1, null, 'unknown'), row(10, 0, 'empty')];
    expect(sortPoolsByTvl(rows).map((r) => r.key)).toEqual(['empty', 'unknown']);
  });

  test('ties break on key, so the top 3 is the same three pools every refetch', () => {
    const a = sortPoolsByTvl([row(1, 0, 'z'), row(10, 0, 'a'), row(4114, 0, 'm')]);
    const b = sortPoolsByTvl([row(4114, 0, 'm'), row(1, 0, 'z'), row(10, 0, 'a')]);
    expect(a.map((r) => r.key)).toEqual(['a', 'm', 'z']);
    expect(b.map((r) => r.key)).toEqual(a.map((r) => r.key));
  });

  test('does not mutate the input', () => {
    const rows = [row(1, 1, 'a'), row(10, 2, 'b')];
    sortPoolsByTvl(rows);
    expect(rows.map((r) => r.key)).toEqual(['a', 'b']);
  });
});

describe('poolsWindow', () => {
  test('opens on the top 3 with a Show more control', () => {
    const w = poolsWindow({ total: 228, expanded: false, page: 0 });
    expect(w.start).toBe(0);
    expect(w.end).toBe(EXPLORE_POOLS_COLLAPSED_ROWS);
    expect(w.showMore).toBe(true);
    expect(w.showPager).toBe(false);
  });

  test('a list of 3 or fewer needs no Show more', () => {
    for (const total of [0, 1, 2, 3]) {
      const w = poolsWindow({ total, expanded: false, page: 0 });
      expect(w.end).toBe(total);
      expect(w.showMore).toBe(false);
    }
  });

  test('Show more counts the rows it ADDS, never the ones already on screen', () => {
    // 12 pools, 3 of them visible: "12 of 12" would be telling someone already
    // reading three rows that twelve are hidden.
    const w = poolsWindow({ total: 12, expanded: false, page: 0 });
    expect(w.showMoreCount).toBe(9);
    expect(w.hiddenCount).toBe(9);
  });

  test('a long list adds a page worth minus what is already shown', () => {
    const w = poolsWindow({ total: 228, expanded: false, page: 0 });
    expect(w.showMoreCount).toBe(EXPLORE_POOLS_PAGE_SIZE - EXPLORE_POOLS_COLLAPSED_ROWS);
    expect(w.hiddenCount).toBe(225);
  });

  test('the added count matches what the press actually reveals', () => {
    for (const total of [4, 12, 25, 26, 228]) {
      const before = poolsWindow({ total, expanded: false, page: 0 });
      const after = poolsWindow({ total, expanded: true, page: 0 });
      expect(before.showMoreCount).toBe(after.end - before.end);
    }
  });

  test('expanding hands the table to a 25-row pager', () => {
    const w = poolsWindow({ total: 228, expanded: true, page: 0 });
    expect(w.start).toBe(0);
    expect(w.end).toBe(25);
    expect(w.pageCount).toBe(10);
    expect(w.showPager).toBe(true);
    expect(w.showMore).toBe(false);
  });

  test('a later page slices from that page', () => {
    const w = poolsWindow({ total: 228, expanded: true, page: 3 });
    expect(w.start).toBe(75);
    expect(w.end).toBe(100);
    expect(w.page).toBe(3);
  });

  test('the last page is short, never past the end', () => {
    const w = poolsWindow({ total: 228, expanded: true, page: 9 });
    expect(w.start).toBe(225);
    expect(w.end).toBe(228);
  });

  test('expanded but short: pager stays off', () => {
    const w = poolsWindow({ total: 4, expanded: true, page: 0 });
    expect(w.end).toBe(4);
    expect(w.pageCount).toBe(1);
    expect(w.showPager).toBe(false);
  });

  test('a chain filter that shortens the list clamps the page instead of emptying it', () => {
    // Viewer was on page 4 of 10 and picked one chain: 6 pools, one page.
    const w = poolsWindow({ total: 6, expanded: true, page: 3 });
    expect(w.page).toBe(0);
    expect(w.start).toBe(0);
    expect(w.end).toBe(6);
    expect(w.showPager).toBe(false);
  });

  test('never slices past the end, at any total or page', () => {
    for (const total of [0, 1, 3, 24, 25, 26, 228]) {
      for (const expanded of [false, true]) {
        for (let page = 0; page < 12; page++) {
          const w = poolsWindow({ total, expanded, page });
          expect(w.start).toBeLessThanOrEqual(w.end);
          expect(w.end).toBeLessThanOrEqual(total);
          expect(w.page).toBeLessThan(w.pageCount);
        }
      }
    }
  });
});

describe('formatPoolTokenAmount', () => {
  test('formats a wei-scale amount with the shared balance format', () => {
    expect(formatPoolTokenAmount('12026977826937613902', 18, 'ETH')).toBe('12.02698 ETH');
    expect(formatPoolTokenAmount('12000000000000000000', 18, 'ETH')).toBe('12.00 ETH');
  });

  test('reads decimals from the row it was given, not from a default', () => {
    // The same base-unit string is 100 USDC at 6 decimals and dust at 18: the
    // amount and its decimals have to come from one and the same pool row.
    expect(formatPoolTokenAmount('100000000', 6, 'USDC')).toBe('100 USDC');
    expect(formatPoolTokenAmount('100000000', 18, 'USDC')).toBe('0.0000000001 USDC');
  });

  test('compacts thousands and millions', () => {
    expect(formatPoolTokenAmount('2500000000', 6, 'USDC')).toBe('2.50K USDC');
    expect(formatPoolTokenAmount('3400000000000', 6, 'USDC')).toBe('3.40M USDC');
  });

  test('omits rather than claiming an empty pool', () => {
    expect(formatPoolTokenAmount('0', 18, 'ETH')).toBe(null);
    expect(formatPoolTokenAmount(undefined, 18, 'ETH')).toBe(null);
    expect(formatPoolTokenAmount('', 18, 'ETH')).toBe(null);
    expect(formatPoolTokenAmount('not-a-number', 18, 'ETH')).toBe(null);
  });
});

describe('showMoreLabel', () => {
  test('counts only when one tap leaves rows hidden', () => {
    expect(showMoreLabel(50, 71)).toBe('Show more (50 of 71)');
    expect(showMoreLabel(5, 5)).toBe('Show more');
  });
});

describe('formatCompactTokenAmount', () => {
  test('one shape for every pool size', () => {
    expect(formatCompactTokenAmount(134.36539, 'ETH')).toBe('134.37 ETH');
    expect(formatCompactTokenAmount(55414.12, 'USDC')).toBe('55.41K USDC');
    expect(formatCompactTokenAmount(12.02698, 'ETH')).toBe('12.02698 ETH');
  });

  test('picks the unit from the rounded figure', () => {
    expect(formatCompactTokenAmount(999.996, 'ETH')).toBe('1.00K ETH');
    expect(formatCompactTokenAmount(999_996, 'USDC')).toBe('1.00M USDC');
    expect(formatCompactTokenAmount(999.99, 'ETH')).toBe('999.99 ETH');
    expect(formatCompactTokenAmount(999_990, 'USDC')).toBe('999.99K USDC');
  });
});
