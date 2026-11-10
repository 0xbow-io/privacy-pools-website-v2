/**
 * Protocol-statistics read model for the Explore page (app/explore/index.tsx).
 *
 * EVERY number this hook returns is REAL ASP data. Two sources:
 *   - `GlobalStatistics` (`apiClient.getGlobalStatistics()` →
 *     `/global/public/statistics`), taken straight off `usePools()` so the
 *     Stats page shares the provider's read of the same public-feed-scheduler
 *     cache instead of adding a second observer of the same endpoint.
 *   - `AssetsStatsResponse` for chainId `'all'` (`/all/public/assets-stats`)
 *     for BOTH the summary totals and the per-pool rows. Explore is a protocol
 *     page, so its pool table lists every chain THIS BUILD serves rather than
 *     just the selected one; the ASP's `all` feed is the only chain-attributed
 *     source, and it answers for chains the build does not enable (BSC today),
 *     so the rows are scoped by `poolTableChains()` before anything is drawn.
 *     The provider filters the same feed to its selected chain, but only
 *     exposes the derived `allPools` shape, which drops the per-asset deposit
 *     COUNT, the PENDING value and the raw `growth24h`.
 *
 * Missing-data policy (house rule, mirrors config/yield.ts): a value that
 * cannot be resolved comes back as `null` and the UI OMITS it. Nothing here
 * ever substitutes a zero, a dash or a fabricated figure for an unknown.
 */
import { isTestnetChain, mainnetChainIds, STELLAR_OPT_IN, supportedChainIds } from '@/config/chains';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useMemo } from 'react';
import { usePublicFeed } from '@/hooks/use-public-feed';
import { feedData } from '@/services/public-feed-scheduler';
import { FEED_ASSETS_STATS_ALL } from '@/services/public-feeds';
import { usePools } from '@/components/pools-provider';
import { useDebug } from '@/components/debug-provider';

import { getChainConfig } from '@/config/chains';
import { getTokenMetadata, isStablecoin } from '@/config/tokens';
import { displayTokenSymbol, isShareSymbol } from '@/services/share-display';
import { shareExactAsUnderlying } from '@/services/share-rates';
import { useShareRates } from '@/hooks/use-share-rates';
import { formatUnits } from 'viem';
import type { AssetStats, AssetsStatsResponse, GlobalStatistics } from '@/services/api-types';
import { finiteOrNull, foldRowsPerAsset } from '@/services/stats-asset-fold';
import {
  filterRowsToChains,
  formatCompactTokenAmount,
  formatPoolTokenAmount,
  poolChainFilterOptions,
  poolTableChains,
  sortPoolsByTvl,
  type PoolChain,
} from '@/services/explore-pools';

/** One per-asset ("per-pool") row, pre-resolved to display-ready strings. */
export type StatsAssetRow = {
  /** Stable list key — the lowercased token address. */
  key: string;
  /** Display symbol resolved from the token ADDRESS: the ASP sometimes
   *  returns the address in `tokenSymbol`, which would label a row "0X1C7D". */
  symbol: string;
  tokenAddress: string;
  chainId: number;
  /** Pool TVL in USD (`totalInAssetValueUsd`, price-repaired — see below). */
  tvlUsd: number | null;
  /** Pool TVL token-denominated, e.g. "1.2345 ETH" — from the provider's
   *  already-formatted `allPools` entry (raw `totalInAssetValue` ÷ decimals). */
  tvlTokenText: string | null;
  /** Cumulative APPROVED deposits in USD (`acceptedDepositsValueUsd`). */
  fundsAcceptedUsd: number | null;
  /** Deposits awaiting ASP review, USD (`pendingDepositsValueUsd`). */
  pendingUsd: number | null;
  /** All-time deposit count for this asset (`totalDepositsCount`). */
  depositsCount: number | null;
  /** All-time withdrawal count (`withdrawalsCount`). */
  withdrawalsCount: number | null;
  /** All-time transfer count (`transfersCount`). */
  transfersCount: number | null;
  /** Average deposit size, USD (`avgDepositSizeUsd`). */
  avgDepositUsd: number | null;
  /** Median deposit size, USD (`medianDepositSizeUsd`). */
  medianDepositUsd: number | null;
  /** `growth24h` as served (percent). null when the ASP has no 24h basis. */
  growth24h: number | null;
};

/**
 * The chain-scoped protocol totals the summary row renders.
 *
 * Every field is a SUM over the chains in scope (see `scopeLabel`), derived
 * from the per-chain assets-stats feed. A field the feed does not carry for
 * those chains stays null and the UI omits it — never a zero.
 */
export type ScopedTotals = {
  tvlUsd: number | null;
  totalDepositsUsd: number | null;
  depositsCount: number | null;
  withdrawalsCount: number | null;
  transfersCount: number | null;
  /** Human-readable scope, e.g. "Ethereum + Optimism" or "Sepolia". */
  scopeLabel: string;
  /** True when the scope is a single test network the user selected. */
  isTestnetScope: boolean;
  /** Freshness stamp of the feed these totals came from; null until it loads. */
  cacheTimestamp: string | null;
};

export type GlobalStatisticsView = {
  /**
   * Raw protocol-wide aggregate straight off /global/public/statistics.
   *
   * PROTOCOL-WIDE MEANS EVERY CHAIN THE ASP INDEXES, TESTNETS INCLUDED, and
   * the payload carries no chain breakdown to filter by — which is why the
   * summary row reads `totals` instead. Kept for the 24h sublines and the
   * freshness stamp, which have no per-chain source.
   */
  statistics: GlobalStatistics | null;
  /** Chain-scoped totals for the summary row (testnets excluded by default). */
  totals: ScopedTotals;
  /**
   * Per-pool rows, richest first, across EVERY chain this build serves.
   * Empty until assets-stats resolves.
   */
  assets: StatsAssetRow[];
  /** Chains present in `assets`, for the pool table's own Chain control. */
  chainOptions: PoolChain[];
  /** True while the protocol aggregates are still in flight. */
  isLoading: boolean;
  /** True while the per-asset rows are still in flight. */
  isAssetsLoading: boolean;
  /** First failing upstream, message only; null when everything resolved. */
  error: string | null;
  /** The selected chain. The pool rows are no longer scoped to it. */
  chainId: number;
};

/** Sum a field across rows, returning null when NO row carried a value. */
function sumOrNull(rows: AssetStats[], pick: (row: AssetStats) => number | null): number | null {
  let total = 0;
  let sawOne = false;
  for (const row of rows) {
    const value = pick(row);
    if (value === null) continue;
    total += value;
    sawOne = true;
  }
  return sawOne ? total : null;
}

/**
 * Resolve a USD figure from an assets-stats pair (usd string + raw
 * token-amount string), repairing the ASP's known stablecoin gap.
 *
 * Why: the ASP has no server-side price feed for stablecoins and returns
 * "0.00" for their USD values while the raw token amount is correct — a pool
 * genuinely holding USDC would render as $0. components/pools-provider.tsx
 * repairs this the same way for TVL and "funds accepted"; this mirrors it for
 * the fields the provider doesn't expose. A stablecoin is valued at $1, other
 * assets at the provider's live price map. When neither the USD figure nor a
 * price is available the result is null and the caller omits the number.
 */
function resolveUsd(
  usdRaw: string | undefined,
  rawAmount: string | undefined,
  decimals: number,
  symbol: string,
  priceMap: Record<string, number>,
  addressKey: string,
): number | null {
  const usd = finiteOrNull(usdRaw);
  if (usd !== null && usd > 0) return usd;
  const raw = finiteOrNull(rawAmount);
  if (raw === null || raw <= 0) return usd; // genuine zero, or unknown (null)
  const tokenAmount = raw / 10 ** decimals;
  if (isStablecoin(symbol)) return tokenAmount;
  const price = priceMap[addressKey] || priceMap[symbol] || 0;
  return price > 0 ? tokenAmount * price : null;
}

export function useGlobalStatistics(): GlobalStatisticsView {
  const { data, statistics, isLoading, error } = usePools();
  // The SELECTED chain, not the selected EVM chain. useActiveEvmChain() falls
  // back to the default EVM chain whenever a non-EVM chain is active, so
  // picking Sui Testnet used to show Sepolia's totals on a page whose header
  // said Sui. It still scopes the summary row (a testnet is summed only when
  // the viewer is standing on it) and still decides whether Sui's pool is in
  // the table; the pool rows themselves are no longer pinned to it.
  const { activeChainId } = useChainRouter();
  const { isDebugEnabled } = useDebug();
  // Share pools (ppUSDC / ppUSDT) are shown in their underlying: the rate is
  // the same one My balances converts with.
  const { rateFor } = useShareRates();

  // ONE assets-stats request for the whole page. /global/public/statistics has
  // no chain breakdown at all, and assets-stats is the only chain-attributable
  // source, so ask it for every chain at once ('all' is a supported chainId)
  // and scope in this file: the summary row sums mainnets, the pool table lists
  // every chain the build serves. This used to be two queries (one pinned to
  // the selected chain for the pool rows) — the second one went away with the
  // per-chain pool table, not with a caching trick.
  // Read-only, from the app-wide public-feed scheduler. It used to be a
  // useQuery that fetched only while this page was mounted, so the request
  // existing said "this client is looking at Explore". This particular query
  // was not transaction-gated; the provider's per-chain query was. Every client
  // now fetches the all-chains feed on the grid and this page reads the cache.
  const assetsStatsFeed = usePublicFeed<AssetsStatsResponse>(FEED_ASSETS_STATS_ALL);
  const allChainsStats = feedData(assetsStatsFeed);
  // "Loading" is now "the scheduler has not answered yet", and a failed
  // refresh that still has a last good value is NOT loading.
  const isTotalsLoading = allChainsStats === undefined && assetsStatsFeed.status !== 'error';
  const totalsError = assetsStatsFeed.status === 'error' ? assetsStatsFeed.error : null;

  const totals = useMemo<ScopedTotals>(() => {
    // Scope: a test network is only ever summed when the user is standing on
    // it — they picked it, so its numbers are the ones they asked to see.
    // Otherwise the scope is every mainnet this build serves.
    const onTestnet = isTestnetChain(activeChainId);
    const scopeIds = onTestnet ? [activeChainId] : mainnetChainIds;
    const scope = new Set(scopeIds);
    const scopeLabel = scopeIds
      .map((id) => getChainConfig(id)?.displayName ?? `chain ${id}`)
      .join(' + ');

    const rows = (allChainsStats?.assets ?? []).filter((row) =>
      scope.has(finiteOrNull(row.chainId) ?? -1),
    );

    // USD figures go through the SAME stablecoin repair the per-asset cards
    // use. The ASP has no server-side stablecoin price feed and returns "0.00"
    // for their USD while the raw token amount is correct — summing the raw
    // strings made a pool holding 1,000,000 USDC contribute $0 to the headline
    // TVL while the card directly below it showed the repaired $1.0M. On a
    // mainnet scope, where most value is stablecoins, that is most of the
    // protocol missing from its own total.
    const rowUsd = (
      row: AssetStats,
      usdRaw: string | undefined,
      rawAmount: string | undefined,
    ): number | null => {
      const addressKey = String(row.tokenAddress || '').toLowerCase();
      if (!addressKey) return finiteOrNull(usdRaw);
      const meta = getTokenMetadata(addressKey, finiteOrNull(row.chainId) ?? activeChainId);
      return resolveUsd(usdRaw, rawAmount, meta.decimals, meta.symbol, data.priceMap, addressKey);
    };

    return {
      tvlUsd: sumOrNull(rows, (r) => rowUsd(r, r.totalInAssetValueUsd, r.totalInAssetValue)),
      totalDepositsUsd: sumOrNull(rows, (r) => rowUsd(r, r.totalDepositsValueUsd, r.totalDepositsValue)),
      depositsCount: sumOrNull(rows, (r) => finiteOrNull(r.totalDepositsCount)),
      withdrawalsCount: sumOrNull(rows, (r) => finiteOrNull(r.withdrawalsCount)),
      transfersCount: sumOrNull(rows, (r) => finiteOrNull(r.transfersCount)),
      scopeLabel: scopeLabel || 'no chains configured',
      isTestnetScope: onTestnet,
      // The stamp that belongs to THESE numbers. Labelling them with the
      // global query's timestamp dated one feed's figures by another's clock.
      cacheTimestamp: allChainsStats?.cacheTimestamp ?? null,
    };
  }, [allChainsStats?.assets, allChainsStats?.cacheTimestamp, data.priceMap, activeChainId]);

  // The chains the pool table covers: every chain THIS BUILD enables, with the
  // usual Sui gate. Not a hardcoded list, because a staging build serves
  // mainnet + Citrea + Optimism on top of the ordinary chain.
  const poolChains = useMemo(
    () =>
      poolTableChains({
        supported: supportedChainIds.map((id) => ({
          id,
          label: getChainConfig(id)?.displayName ?? `Chain ${id}`,
          chainType: getChainConfig(id)?.chainType ?? 'evm',
        })),
        activeChainId,
        isDebugEnabled,
        stellarOptIn: STELLAR_OPT_IN,
      }),
    [activeChainId, isDebugEnabled],
  );

  const assets = useMemo<StatsAssetRow[]>(() => {
    // Scoped BEFORE anything is mapped: the ASP's `all` feed answers for chains
    // this build does not serve, and getTokenMetadata has nothing to say about
    // a token on one of them.
    const rows = filterRowsToChains(
      allChainsStats?.assets ?? [],
      (row) => finiteOrNull(row.chainId),
      poolChains.map((chain) => chain.id),
    );
    if (rows.length === 0) return [];

    // The ASP returns ONE ROW PER POOL, so an asset that exists in more than one
    // pool era (the V8 -> V9 cutover) comes back twice for the same chain +
    // token — verified live on Sepolia: ETH/USDC/USDT each appear twice, e.g.
    // ETH as 99 deposits/$24k and 500 deposits/$341k. The response carries no
    // pool/entrypoint identifier, so the rows cannot be told apart or labelled;
    // rendering them raw produced duplicate, indistinguishable cards (and a
    // duplicate React key, since the key was just the address).
    //
    // This page is PROTOCOL-WIDE, so the honest answer is the sum across pools:
    // total ETH ever deposited, total ETH held now. Values are folded in their
    // own units — base-unit amounts as BigInt (they are wei-scale and would lose
    // precision as floats), USD and counts as numbers.
    const folded = foldRowsPerAsset(rows, activeChainId);

    const mapped: StatsAssetRow[] = [];
    for (const stat of folded) {
      const addressKey = String(stat.tokenAddress || '').toLowerCase();
      if (!addressKey) continue;
      const chainId = finiteOrNull(stat.chainId) ?? activeChainId;
      const meta = getTokenMetadata(addressKey, chainId);
      mapped.push({
        key: `${chainId}:${addressKey}`,
        symbol: meta.symbol,
        tokenAddress: stat.tokenAddress,
        chainId,
        tvlUsd: resolveUsd(
          stat.totalInAssetValueUsd,
          stat.totalInAssetValue,
          meta.decimals,
          meta.symbol,
          data.priceMap,
          addressKey,
        ),
        // Derived from THIS row's own base-unit amount and decimals. It used to
        // borrow the provider's formatted string, which is built for a single
        // chain and keyed by token address alone: on a multi-chain table the
        // Optimism and mainnet ETH rows would both have shown Sepolia's ETH
        // balance, since the native sentinel address is the same on all three.
        // It also folds the pool eras the same way tvlUsd does, so the token
        // figure and the dollar figure beside it finally describe one number.
        // Headlines the money (services/share-display.ts): a share pool's TVL
        // is CONVERTED through the share rate and labelled with the underlying
        // ("366.61 USDC"), like My balances; while the rate is still loading
        // the token figure is omitted rather than shown in shares (Pat,
        // 2026-09-07, on Nat's Explore screenshot; codex on 28daca7).
        tvlTokenText: shareTvlText(stat.totalInAssetValue, meta.decimals, meta.symbol, isShareSymbol(meta.symbol) ? rateFor(chainId, addressKey) : undefined),
        fundsAcceptedUsd: resolveUsd(
          stat.acceptedDepositsValueUsd ?? stat.totalDepositsValueUsd,
          stat.acceptedDepositsValue ?? stat.totalDepositsValue,
          meta.decimals,
          meta.symbol,
          data.priceMap,
          addressKey,
        ),
        pendingUsd: resolveUsd(
          stat.pendingDepositsValueUsd,
          stat.pendingDepositsValue,
          meta.decimals,
          meta.symbol,
          data.priceMap,
          addressKey,
        ),
        depositsCount: finiteOrNull(stat.totalDepositsCount),
        // Already served per-asset by the ASP (TimeBasedStatsDto): counts and
        // the deposit-size averages. Each is finiteOrNull'd, so a field the
        // deployed API doesn't send yet is OMITTED rather than shown as 0 —
        // that is the graceful fallback, no separate demo data needed.
        withdrawalsCount: finiteOrNull(stat.withdrawalsCount),
        transfersCount: finiteOrNull(stat.transfersCount),
        avgDepositUsd: finiteOrNull((stat as { avgDepositSizeUsd?: number | string }).avgDepositSizeUsd),
        medianDepositUsd: finiteOrNull(
          (stat as { medianDepositSizeUsd?: number | string }).medianDepositSizeUsd,
        ),
        growth24h: finiteOrNull(stat.growth24h),
      });
    }
    return sortPoolsByTvl(mapped);
  }, [allChainsStats?.assets, data.priceMap, activeChainId, poolChains, rateFor]);

  const chainOptions = useMemo(
    () => poolChainFilterOptions(assets, poolChains),
    [assets, poolChains],
  );

  const combinedError = useMemo(() => {
    if (error) return error;
    // The all-chains query is the ONLY source for both the summary row and the
    // pool table, so its failure has to reach the UI. Dropping it left the card
    // saying "unavailable" with no reason.
    if (totalsError) return totalsError instanceof Error ? totalsError.message : String(totalsError);
    return null;
  }, [error, totalsError]);

  return {
    statistics,
    totals,
    assets,
    chainOptions,
    // The summary row reads `totals`, which comes from the all-chains query —
    // so "still loading" must include that query, or a cold visit renders
    // "unavailable" over figures that are merely in flight.
    isLoading: isLoading || isTotalsLoading,
    // Same query now feeds the pool table, so the two share a loading flag.
    isAssetsLoading: isTotalsLoading,
    error: combinedError,
    chainId: activeChainId,
  };
}

/// The pool's token-denominated TVL. A plain asset: "1.2345 ETH". A yield share
/// with its rate known: converted to the underlying ("366.61 USDC"); without
/// the rate: null (never a share count under an underlying label).
function shareTvlText(
  rawBaseUnits: string | number | bigint | undefined | null,
  decimals: number,
  symbol: string,
  rate: ReturnType<ReturnType<typeof useShareRates>['rateFor']>,
): string | null {
  if (!isShareSymbol(symbol)) return formatPoolTokenAmount(rawBaseUnits as string | number | undefined | null, decimals, symbol);
  if (!rate || rawBaseUnits === undefined || rawBaseUnits === null || rawBaseUnits === '') return null;
  let exact: string;
  try {
    exact = formatUnits(BigInt(rawBaseUnits), decimals);
  } catch {
    return null;
  }
  const converted = shareExactAsUnderlying(exact, rate);
  return converted === null ? null : formatCompactTokenAmount(converted, displayTokenSymbol(rate.underlyingSymbol));
}
