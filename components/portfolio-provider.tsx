import { useBalanceDisplay } from '@/hooks/use-balance-display';
// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay; shares appear
// only in the (i) hint, in fields labelled with the share symbol, or while the
// rate is unknown. Never print a share count under the underlying symbol.
// Exception: Withdraw/Send edits cross shareAmountFromUnderlying once; untouched
// MAX retains the original exact shares. USD edits use an exact decimal price
// in that same boundary. No other operation converts display back.
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import { createContext, useContext, useMemo, ReactNode } from 'react';
import { formatUnits, parseUnits } from 'viem';
import { usePools } from '@/components/pools-provider';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useShareRates } from '@/hooks/use-share-rates';

import { useAllChainsPriceMap } from '@/hooks/use-all-chains-price-map';
import { EMPTY_PRICE_MAP, priceFromMap } from '@/services/price-map-merge';
import { getChainConfig } from '@/config/chains';
import { getConfiguredYieldDeployments } from '@/config/yield';
import { getKnownTokenMetadata, isStablecoin, formatTokenBalance } from '@/config/tokens';
import { buildPortfolioPositions } from '@/services/portfolio-positions';
import { formatUsdPrecise } from '@/services/format-fiat';
import { totalYieldEarnedUsd, yieldEarnedDisplay, yieldEarnedKey, type YieldEarnedDisplay } from '@/services/yield-earned';

// --- Types ---

export type PortfolioPosition = {
  tokenSymbol: string;
  tokenAddress: string;
  /** Chain the holding lives on (balances span chains). */
  chainId?: number;
  /** ACTIVE (leaf-gated spendable) balance — yield rows: redeemable underlying. */
  balance: number;
  balanceFormatted: string;
  shareHint?: string | null;
  /** ACTIVE USD value — the only figure feeding Net Value / allocation. */
  valueUsd: number;
  valueUsdFormatted: string;
  /** Pending funds for this token, carried separately and labeled. */
  pendingLabel: string | null;
  /** Configured yield shares presented under their underlying coin. */
  isYield: boolean;
  /** Yield value loading/errored — render "—", never $0. */
  valueUnavailable: boolean;
  /** Spend action allowed only for canonical active funds. */
  withdrawEnabled: boolean;
  /** Actual note/payout symbol for a yield row, e.g. ppUSDC. */
  shareSymbol?: string;
  /**
   * Yield row only: earned to date in the underlying ("+1.23 USDC"), or null
   * for "—" (no figure, or one whose error bound shows at display precision).
   */
  earnedText?: string | null;
};

type PortfolioContextType = {
  positions: PortfolioPosition[];
  totalValue: number;
  totalValueFormatted: string;
  pendingValue: number;
  pendingValueFormatted: string;
  isLoading: boolean;
  hasPositions: boolean;
  error: string | null;
  /** Display name of the chain the positions belong to. */
  chainDisplayName: string;
  /**
   * Chain the positions belong to. Exposed alongside the display name because
   * links out of the portfolio must target THAT chain — building a pool URL
   * without it silently falls back to the default chain, and the pool page
   * then switches the app to whatever the URL said.
   */
  chainId: number;
  /**
   * Sum of every yield row's earned figure, USD-formatted, or null for "—":
   * a total that skipped a row without a figure would understate it.
   */
  yieldEarnedUsdFormatted: string | null;
};

// --- Context ---

const PortfolioContext = createContext<PortfolioContextType | undefined>(undefined);

// Precise USD ("$1,234.56") — canonical rules in services/format-fiat.ts.
const formatUsd = formatUsdPrecise;

/**
 * Portfolio balance source (codex P1 rework): consumes the CANONICAL
 * per-token aggregation from pools-provider (notes + association-set leaf
 * gating + deduplicated deposit events) instead of re-deriving balances
 * from raw notes/history — a second model resurrected spent deposits as
 * phantom positions and showed leaf-unconfirmed value as withdrawable.
 * ppUSDC yield shares are classified BEFORE the generic rows and valued via
 * shared public vault rates under the underlying symbol.
 *
 * Chain scope (codex P2): the portfolio page is EVM-yield-only by design —
 * PortfolioPageContent redirects unless the ACTIVE chain is a yield-enabled
 * EVM chain, and this provider reads the same active chain, so rows can
 * never mislabel another chain's notes as default-chain assets.
 */
export function PortfolioProvider({ children }: { children: ReactNode }) {
  const { isSui: isSuiChain, isStellar, activeChainId } = useChainRouter();
  // Non-EVM chain (Sui or Stellar): the EVM-only surfaces below stay off.
  const isSui = isSuiChain || isStellar;
  const defaultChain = useActiveEvmChain();
  const chainId = !isSui && activeChainId ? activeChainId : defaultChain.id;
  const chainDisplayName = getChainConfig(chainId)?.displayName ?? `Chain ${chainId}`;

  const { data: poolsData, yieldEarned, isLoading: poolsLoading, error: poolsError } = usePools();
  const { rateFor, loading: ratesLoading } = useShareRates();
  const balanceDisplay = useBalanceDisplay(chainId);

  // Off the public-feed grid, not a query. The chain-scoped getAllPrices()
  // this replaces shared the scheduler's cache scope, but only while that
  // cache was warm: the TTL and the grid period are both five minutes, so an
  // off-grid bootstrap left a window in which mounting this provider — or a
  // window focus, or a post-transaction invalidation — put the request on the
  // wire itself (codex, 2026-09-15). Every chain, so a foreign row gets its
  // OWN chain's price instead of the zero the guard below used to hand it.
  const priceMap = useAllChainsPriceMap(chainId);
  // Nothing has answered yet. The grid keeps the last good value through a
  // failed tick, so an empty map means "not yet", never "prices are gone".
  const pricesLoading = priceMap === EMPTY_PRICE_MAP;

  const yieldSources = useMemo(() => poolsData.myPools.flatMap((pool) => {
    const deployment = getConfiguredYieldDeployments(pool.chainId)
      .find((d) => d.ppUSDC.toLowerCase() === pool.tokenAddress.toLowerCase());
    if (!deployment) return [];
    const rate = rateFor(pool.chainId, deployment.ppUSDC);
    const underlyingPerShare = rate ? Number(formatUnits(rate.assetsPerShare, rate.underlyingDecimals)) : undefined;
    return [{
      chainId: pool.chainId,
      underlyingSymbol: deployment.underlyingSymbol,
      shareSymbol: getKnownTokenMetadata(deployment.ppUSDC, pool.chainId)?.symbol ?? pool.name,
      ppUSDCAddress: deployment.ppUSDC,
      underlyingPerShare,
      redeemableUnderlying: underlyingPerShare == null ? 0 : Number(pool.balanceTokenExact) * underlyingPerShare,
      hasShares: Number(pool.balanceTokenExact) > 0,
      pendingShares: parseUnits(pool.pendingTokenExact || '0', deployment.ppUSDCDecimals),
      ppUSDCDecimals: deployment.ppUSDCDecimals,
      valueLoading: !rate && ratesLoading,
      valueError: !rate && !ratesLoading,
    }];
  }), [poolsData.myPools, rateFor, ratesLoading]);

  const { positions, totalValue, pendingValue, pendingValueUnavailable, hasPositions, yieldEarnedUsd } = useMemo(() => {
    // Chain-qualified. Every EVM chain shares the one native sentinel address
    // 0xEeee…, so a bare address lookup priced a Citrea cBTC row in ether
    // (qwen3.8 confirmation review). The old guard answered 0 for any foreign
    // row to avoid that; priceFromMap answers with the row's OWN chain's price
    // and only falls back to a bare key when that chain has no figure.
    const priceFor = (tokenAddress: string, symbol: string, rowChainId?: number) =>
      priceFromMap(priceMap, { chainId: rowChainId ?? chainId, address: tokenAddress, symbol })
      ?? (isStablecoin(symbol) ? 1 : 0);
    const aggregated = buildPortfolioPositions({
      pools: poolsData.myPools.map((pool) => ({
        symbol: pool.name,
        tokenAddress: pool.tokenAddress,
        chainId: pool.chainId,
        activeBalance: parseFloat(pool.balanceTokenExact) || 0,
        pendingBalance: parseFloat(pool.pendingTokenExact) || 0,
      })),
      priceFor,
      yieldSources,
    });

    // Earned per yield row, in the underlying the row is shown in. Read from
    // PoolsProvider, which computes it on its own cadence; nothing here asks.
    const earnedRows: { earned: YieldEarnedDisplay | null; underlyingPriceUsd: number }[] = [];
    const earnedFor = (p: (typeof aggregated.positions)[number]): YieldEarnedDisplay | null => {
      if (!p.isYield) return null;
      // A yield row with no chain has no figure; it must still count, or the
      // tile would sum the others and silently read low.
      if (p.chainId === undefined) {
        earnedRows.push({ earned: null, underlyingPriceUsd: 0 });
        return null;
      }
      const earned = yieldEarnedDisplay(yieldEarned.get(yieldEarnedKey(p.chainId, p.tokenAddress)), p.tokenSymbol);
      earnedRows.push({ earned, underlyingPriceUsd: priceFor('', p.tokenSymbol, p.chainId) });
      return earned;
    };

    const positions: PortfolioPosition[] = aggregated.positions.map((p) => {
      const earned = earnedFor(p);
      const held = p.isYield ? poolsData.myPools.find(pool => pool.chainId === p.chainId && pool.tokenAddress.toLowerCase() === p.tokenAddress.toLowerCase()) : undefined;
      const shareView = held ? balanceDisplay(held.balanceTokenExact, held.name, held.chainId, held.tokenAddress) : null;
      let pendingLabel: string | null = null;
      if (p.pendingBalance > 0) {
        pendingLabel = p.pendingValueUnavailable
          ? `${`${formatTokenBalance(p.pendingBalance, p.shareSymbol ?? p.tokenSymbol)} ${p.shareSymbol ?? p.tokenSymbol}`} pending. Value unavailable.`
          : `${formatTokenBalance(p.pendingBalance, p.tokenSymbol)} ${p.tokenSymbol} pending`;
      }
      return {
        tokenSymbol: p.tokenSymbol,
        tokenAddress: p.tokenAddress,
        ...(p.chainId !== undefined ? { chainId: p.chainId } : {}),
        balance: p.activeBalance,
        balanceFormatted: formatTokenBalance(p.activeBalance, p.tokenSymbol),
        shareHint: shareView?.hint,
        valueUsd: p.activeValueUsd,
        valueUsdFormatted: formatUsd(p.activeValueUsd),
        pendingLabel,
        isYield: p.isYield,
        ...(p.shareSymbol ? { shareSymbol: p.shareSymbol } : {}),
        valueUnavailable: p.valueUnavailable,
        withdrawEnabled: p.withdrawEnabled,
        ...(p.isYield ? { earnedText: earned?.text ?? null } : {}),
      };
    });

    return {
      positions,
      totalValue: aggregated.totalValueUsd,
      pendingValue: aggregated.pendingValueUsd,
      pendingValueUnavailable: aggregated.pendingValueUnavailable,
      hasPositions: aggregated.hasPositions,
      yieldEarnedUsd: totalYieldEarnedUsd(earnedRows),
    };
  }, [poolsData.myPools, priceMap, chainId, yieldSources, yieldEarned, balanceDisplay]);

  const isLoading = poolsLoading || pricesLoading;
  // usePools surfaces a string. The Error branch that used to be here existed
  // for the price query's thrown object, and the price read is not a query any
  // more: the grid keeps the last good map through a failed tick, so there is
  // no price error to report, only "not yet" (pricesLoading above).
  const error = poolsError ?? null;

  const value: PortfolioContextType = {
    positions,
    totalValue,
    totalValueFormatted: formatUsd(totalValue),
    pendingValue,
    pendingValueFormatted: pendingValueUnavailable ? 'Value unavailable' : formatUsd(pendingValue),
    isLoading,
    hasPositions,
    error,
    chainDisplayName,
    chainId,
    yieldEarnedUsdFormatted: yieldEarnedUsd == null ? null : formatUsd(yieldEarnedUsd),
  };

  return (
    <PortfolioContext.Provider value={value}>
      {children}
    </PortfolioContext.Provider>
  );
}

export function usePortfolio() {
  const context = useContext(PortfolioContext);
  if (context === undefined) {
    throw new Error('usePortfolio must be used within a PortfolioProvider');
  }
  return context;
}
