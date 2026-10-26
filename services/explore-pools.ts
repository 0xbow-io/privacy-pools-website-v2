/**
 * Pure logic behind the Explore page's Pools table
 * (components/stats/stats-asset-cards.tsx, fed by hooks/use-global-statistics.ts).
 *
 * It lives in services/ because CI runs `bun test services scripts` and nothing
 * else — chain scoping, ordering and paging arithmetic left inside a component
 * is never executed by a test run. The component keeps the markup and the
 * useState calls; every decision about WHICH pools and HOW MANY is taken here.
 *
 * No config/ import on purpose: the caller injects the build's chain set, so
 * these functions are exercised against any chain line-up (public build =
 * Sepolia only, staging = mainnet + Citrea + Optimism + Sepolia + Sui) without
 * a module mock or an env var.
 */
import { paginate } from '@/services/paginate';
import { formatTokenBalance } from '@/services/token-format';

/** Pools listed before the viewer presses "Show more". */
export const EXPLORE_POOLS_COLLAPSED_ROWS = 3;
/** Pools per page once expanded. */
export const EXPLORE_POOLS_PAGE_SIZE = 25;

/**
 * A chain the table can carry rows for. Field-for-field the same shape as
 * `ChainFilterOption` in components/pools/blockchain-filter.tsx, so the options
 * this module derives feed that shared dropdown directly rather than through a
 * second, Pools-only filter component.
 */
export type PoolChain = { id: number; label: string; chainType: string };

/**
 * The chains the Pools table covers.
 *
 * "All chains" is whatever THIS BUILD enables, never a hardcoded list: the
 * caller passes config/chains' `supportedChainIds`, which a staging build
 * (EXPO_PUBLIC_STAGING) fills with mainnet + Citrea + Optimism on top of the
 * ordinary chain. The ASP's `/all/public/assets-stats` answers for chains this
 * build does not serve (BSC today), and those rows must not appear.
 *
 * Sui carries the same gate the transactions feed and the deposit network
 * picker already apply (`feedChainIds` in components/pools-provider.tsx,
 * `supportedNetworks` in components/deposit-modal-provider.tsx): out of sight
 * unless debug is on, or the viewer is standing on it.
 */
export function poolTableChains({
  supported,
  activeChainId,
  isDebugEnabled,
  stellarOptIn = false,
}: {
  supported: readonly PoolChain[];
  activeChainId: number;
  isDebugEnabled: boolean;
  /** ?stellar=true (config/chains STELLAR_OPT_IN): Stellar shows without the debug gate. */
  stellarOptIn?: boolean;
}): PoolChain[] {
  return supported.filter(
    (chain) =>
      chain.chainType === 'evm'
      || isDebugEnabled
      || chain.id === activeChainId
      || (stellarOptIn && chain.chainType === 'stellar'),
  );
}

/**
 * Drop rows whose chain is out of scope. `chainIdOf` returns null for a row the
 * feed gave no usable chain id — those go too, rather than being attributed to
 * whichever chain happens to be active.
 */
export function filterRowsToChains<T>(
  rows: readonly T[],
  chainIdOf: (row: T) => number | null,
  chainIds: Iterable<number>,
): T[] {
  const allowed = new Set(chainIds);
  return rows.filter((row) => {
    const id = chainIdOf(row);
    return id !== null && allowed.has(id);
  });
}

/**
 * Chains to offer in the table's own Chain control: those that actually have a
 * pool, in the build's chain order.
 *
 * Order comes from `chains`, not from the rows, so the menu does not reshuffle
 * itself every time a refetch changes which pool is richest.
 */
export function poolChainFilterOptions(
  rows: readonly { chainId: number }[],
  chains: readonly PoolChain[],
): PoolChain[] {
  const present = new Set(rows.map((row) => row.chainId));
  return chains.filter((chain) => present.has(chain.id));
}

/** An empty selection means All, the same contract BlockchainFilter uses. */
export function applyChainFilter<T extends { chainId: number }>(
  rows: readonly T[],
  selected: ReadonlySet<number>,
): T[] {
  if (selected.size === 0) return [...rows];
  return rows.filter((row) => selected.has(row.chainId));
}

/**
 * Richest pool first. A pool whose TVL the ASP did not publish sinks below
 * every known figure instead of sorting as a zero next to genuinely empty
 * pools, and equal rows break the tie on `key` so "the top 3" is the same three
 * pools from one refetch to the next.
 */
export function sortPoolsByTvl<T extends { tvlUsd: number | null; key: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    const byTvl = (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1);
    return byTvl !== 0 ? byTvl : a.key.localeCompare(b.key);
  });
}

export type PoolsWindow = {
  /** Slice bounds of the rows to render. */
  start: number;
  end: number;
  /** Current page, 0-indexed and clamped; 0 while collapsed. */
  page: number;
  pageCount: number;
  /** Render the Prev/Next footer. */
  showPager: boolean;
  /** Render the "Show more" control. */
  showMore: boolean;
  /**
   * The two numbers on the "Show more" label, in the transactions feed's own
   * "(added of hidden)" form: how many rows the press puts on screen, and how
   * many are not on screen yet. Saying "25 of 25" to someone already looking at
   * 3 of those rows is the reading this avoids.
   */
  showMoreCount: number;
  hiddenCount: number;
};

/**
 * Which pools the table draws.
 *
 * Collapsed it is the top 3: Explore stacks summary, pools and the activity
 * feed on one page, and a full pool directory at the top pushes the feed out of
 * reach. "Show more" hands the table over to the pager for good — pages of 25
 * that replace each other in place, the same page-at-a-time shape the
 * transactions feed below flips to, rather than a list that only ever grows.
 * The first page keeps the top 3 at its head, so the press adds 22 rows rather
 * than replacing the three the viewer was already reading.
 *
 * The page index is clamped on read by `paginate`, so a chain filter that
 * shortens the list under a viewer sitting on page 4 lands them on the last
 * page instead of an empty one with no way back.
 */
export function poolsWindow({
  total,
  expanded,
  page,
}: {
  total: number;
  expanded: boolean;
  page: number;
}): PoolsWindow {
  const count = Math.max(0, Math.floor(total) || 0);
  if (!expanded) {
    const end = Math.min(EXPLORE_POOLS_COLLAPSED_ROWS, count);
    return {
      start: 0,
      end,
      page: 0,
      pageCount: Math.max(1, Math.ceil(count / EXPLORE_POOLS_PAGE_SIZE)),
      showPager: false,
      showMore: count > end,
      showMoreCount: Math.min(EXPLORE_POOLS_PAGE_SIZE, count) - end,
      hiddenCount: count - end,
    };
  }
  const paged = paginate(count, EXPLORE_POOLS_PAGE_SIZE, page);
  return {
    start: paged.start,
    end: paged.end,
    page: paged.page,
    pageCount: paged.pageCount,
    showPager: paged.pageCount > 1,
    showMore: false,
    showMoreCount: 0,
    hiddenCount: 0,
  };
}

/**
 * Token-denominated pool size, e.g. "1.2345 ETH".
 *
 * Derived here from the feed's own base-unit amount rather than borrowed from
 * the provider's `allPools`, which is built for ONE chain and keys pools by
 * token address alone: on a multi-chain table every ETH row would have shown
 * the default chain's ETH balance, since the sentinel address is identical on
 * Sepolia, mainnet and Optimism. Same M/K shape as the provider's private
 * formatTokenAmount, with formatTokenBalance below a thousand, so the figure reads the same wherever it appears.
 *
 * null when the feed carries no positive amount — the row omits the line
 * instead of claiming a pool holds nothing.
 */
export function formatPoolTokenAmount(
  rawBaseUnits: string | number | undefined | null,
  decimals: number,
  symbol: string,
): string | null {
  if (rawBaseUnits === undefined || rawBaseUnits === null || rawBaseUnits === '') return null;
  const raw = typeof rawBaseUnits === 'number' ? rawBaseUnits : parseFloat(rawBaseUnits);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const value = raw / 10 ** decimals;
  if (!Number.isFinite(value) || value <= 0) return null;
  return formatCompactTokenAmount(value, symbol);
}

/**
 * A pool-size figure in one shape for every pool, plain or share: M/K above a
 * thousand, two decimals from a hundred up, the shared balance format below.
 * Display only: "134.36539 ETH" beside "55414.12 USDC" read as noise.
 */
export function formatCompactTokenAmount(value: number, symbol: string): string {
  // The unit is picked from the ROUNDED figure, so 999.996 reads 1.00K and
  // 999,996 reads 1.00M, never "1000.00" of the smaller unit.
  const thousands = Math.round(value / 10) / 100;
  if (thousands >= 1_000) return `${(value / 1_000_000).toFixed(2)}M ${symbol}`;
  const cents = Math.round(value * 100) / 100;
  if (cents >= 1_000) return `${thousands.toFixed(2)}K ${symbol}`;
  if (cents >= 100) return `${formatTokenBalance(cents, symbol)} ${symbol}`;
  return `${formatTokenBalance(value, symbol)} ${symbol}`;
}

/**
 * The label of a list's "Show more" control: the count it adds out of the rows
 * still hidden, but only when one tap does not show them all ("5 of 5" says
 * nothing a plain "Show more" does not).
 */
export function showMoreLabel(adds: number, hidden: number): string {
  return adds < hidden ? `Show more (${adds} of ${hidden})` : 'Show more';
}
