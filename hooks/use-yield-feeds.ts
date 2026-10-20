// The three PUBLIC ppUSDC yield feeds shipped by asp-v2 PR #90 (issue #89),
// read from the public-feed grid:
//
//   GET /:chainId/public/yield-deposits?sinceId=<cursor>
//   GET /:chainId/public/ppusdc-rate-history?sinceId=<cursor>
//   GET /:chainId/public/ppusdc-vault-metrics?window=30d
//
// THESE HOOKS CANNOT FETCH. They read a cache the scheduler fills on a fixed
// cadence (services/yield-feed-grid.ts registers them, services/public-feeds.ts
// lists them). That is deliberate and it is a privacy property, not a style
// choice: until 2026-09-21 the history and deposit feeds were fetched from
// components/portfolio/all-positions.tsx and had exactly ONE trigger in the
// app — expanding a position's yield row — so the request announced that
// expansion, and its chain, to the ASP. There is no `enabled`, no `refetch`
// and no `sinceId` here on purpose; adding any of them hands a component the
// ability to put a request on the wire again.
//
// The feeds are CONFIG-GATED DORMANT server-side: until a chain's
// pool_configuration carries privacy_pool_router / pp_yield_token they answer
// 404. That is the normal "not deployed yet" answer and resolves to a clean
// `available: false` with empty data — no error surface. Live on chains 1 and
// 56 as of 2026-09-21; 4114, 10, 11155111 and all of staging still 404.
//
// The paged feeds ACCUMULATE across ticks rather than re-draining (the mainnet
// history is 68 KB and grows hourly) — see services/yield-feed-accumulator.ts.

import { useMemo } from 'react';

import { usePublicFeed } from '@/hooks/use-public-feed';
import { feedData, type FeedState } from '@/services/public-feed-scheduler';
import {
  feedPpUsdcRateHistory,
  feedPpUsdcVaultMetrics,
} from '@/services/yield-feed-grid';
import { YIELD_APY_PERCENT } from '@/config/yield';
import type {
  PpUsdcRateHistoryResponse,
  PpUsdcRateSnapshot,
  PpUsdcVaultMetricsResponse,
} from '@/services/api-types';
import {
  APY_PERIOD_WINDOWS,
  APY_WINDOW_DAYS,
  bpsToPercent,
  deriveNetApySeries,
  grossAaveApyPercent,
  netApySeriesPercents,
  netRealizedApyPercent,
  resolveYieldApy,
  type ApyPeriodLabel,
  type NetApySeriesPoint,
  type ResolvedYieldApy,
  type YieldFeedResult,
} from '@/services/yield-feeds';

export type YieldFeedState<T> = {
  /**
   * true only when the chain HAS the feed configured and it answered. false
   * covers: query disabled, still loading, real error, and the dormant-feed
   * 404 — i.e. "don't show real values".
   */
  available: boolean;
  data: T | undefined;
  isLoading: boolean;
  /** A REAL failure (network/5xx). A dormant-feed 404 is not an error. */
  isError: boolean;
};

/**
 * Map one public-feed-grid entry onto the state shape these hooks have always
 * returned. `empty` is the grid's "no tick has landed yet", which is the
 * honest loading state for data a component is not allowed to demand.
 */
function toFeedState<T>(state: FeedState<YieldFeedResult<T>>): YieldFeedState<T> {
  const result = feedData(state);
  const value = result?.status === 'ok' ? result.value : undefined;
  return {
    available: value !== undefined,
    data: value,
    isLoading: state.status === 'empty',
    // A dormant-feed 404 is folded into `{status:'unavailable'}` by
    // loadYieldFeed and is NOT an error; only a real fetch failure is. The
    // grid keeps its own cadence either way, so there is nothing to retry here.
    isError: state.status === 'error',
  };
}

// ── Feed 1: ppUSDC assets-per-share history ──────────────────────────────

export type PpUsdcRateHistoryState = YieldFeedState<PpUsdcRateHistoryResponse> & {
  snapshots: PpUsdcRateSnapshot[];
  /** Documented capture cadence, seconds (null when unavailable). */
  intervalSeconds: number | null;
  lastSyncedId: string | null;
};

/** ppUSDC assets-per-share (exchangeRate) snapshots with per-observation feeBps. */
export function usePpUsdcRateHistory(params: { chainId: number }): PpUsdcRateHistoryState {
  const state = toFeedState(
    usePublicFeed<YieldFeedResult<PpUsdcRateHistoryResponse>>(feedPpUsdcRateHistory(params.chainId)),
  );
  return {
    ...state,
    snapshots: state.data?.snapshots ?? [],
    intervalSeconds: state.data?.intervalSeconds ?? null,
    lastSyncedId: state.data?.lastSyncedId ?? null,
  };
}

// ── Feed 2: current vault metrics (headline APY) ─────────────────────────

export type PpUsdcVaultMetricsState = YieldFeedState<PpUsdcVaultMetricsResponse> & {
  /** NET ppUSDC realized APY — what a holder earned, after the protocol fee. */
  netRealizedApyPercent: number | null;
  /** DERIVED GROSS Aave supply APY = net / (1 − feeBps). NOT interchangeable. */
  grossAaveApyPercent: number | null;
  /** Protocol yield fee at the latest observation, basis points. */
  feeBps: number | null;
  /** Trailing window the net figure was measured over. */
  netApyWindowDays: number | null;
  latestExchangeRate: string | null;
  latestObservationTimestamp: string | null;
  latestObservationBlock: string | null;
};

/**
 * Latest ppUSDC assets-per-share plus BOTH APYs. Consumers must keep them
 * apart: `netRealizedApyPercent` is the holder's realized yield,
 * `grossAaveApyPercent` is the pre-fee Aave supply figure.
 */
export function usePpUsdcVaultMetrics(params: { chainId: number }): PpUsdcVaultMetricsState {
  const state = toFeedState(
    usePublicFeed<YieldFeedResult<PpUsdcVaultMetricsResponse>>(feedPpUsdcVaultMetrics(params.chainId)),
  );
  const metrics = state.data;
  return {
    ...state,
    netRealizedApyPercent: netRealizedApyPercent(metrics),
    grossAaveApyPercent: grossAaveApyPercent(metrics),
    feeBps: metrics?.grossAaveApy?.feeBps ?? null,
    netApyWindowDays: metrics?.netRealizedApy?.windowDays ?? null,
    latestExchangeRate: metrics?.latest?.exchangeRate ?? null,
    latestObservationTimestamp: metrics?.latest?.observationTimestamp ?? null,
    latestObservationBlock: metrics?.latest?.observationBlock ?? null,
  };
}

// ── Headline APY (real feed → env placeholder → omitted) ─────────────────

export type ResolvedYieldApyState = ResolvedYieldApy & {
  /** Vault-metrics feed answered (real figures are usable). */
  feedAvailable: boolean;
  isLoading: boolean;
};

/**
 * The headline APY for any surface that shows one: the feed's NET ppUSDC
 * realized APY when available, else the static EXPO_PUBLIC_YIELD_APY
 * placeholder, else UNAVAILABLE (the number is omitted — config/yield.ts
 * policy). `source` travels with the value so a real figure is labelled as the
 * net realized APY rather than passed off as Aave's gross supply APY.
 *
 * Only the metrics feed is fetched (no rate history) — cheap enough for a
 * card header.
 */
export function useResolvedYieldApy(params: {
  chainId: number;
}): ResolvedYieldApyState {
  // The window is fixed by the grid (GRID_APY_WINDOW, '30d'). It used to be a
  // per-caller request parameter driven by the chart's selected period, which
  // put a UI selection into the URL and opened a second cache entry per
  // period; the headline figure now always states the 30-day realized APY and
  // `netApyWindowDays` travels with it so no surface can mislabel it.
  const metrics = usePpUsdcVaultMetrics({ chainId: params.chainId });
  const resolved = useMemo(
    () =>
      resolveYieldApy({
        feedNetApyBps: metrics.data?.netRealizedApy?.apyBps ?? null,
        feedWindowDays: metrics.netApyWindowDays,
        envApyPercent: YIELD_APY_PERCENT,
      }),
    [metrics.data, metrics.netApyWindowDays],
  );
  return { ...resolved, feedAvailable: metrics.available, isLoading: metrics.isLoading };
}

// ── Composite: everything the yield history card needs ───────────────────

export type YieldFeedsView = {
  /**
   * Both display feeds answered — real values may be shown (and demo values
   * must not be). They share one server-side gate, so they flip together.
   */
  yieldFeedsAvailable: boolean;
  isLoading: boolean;
  isError: boolean;
  /** Headline APY + provenance (see useResolvedYieldApy). */
  apy: ResolvedYieldApy;
  /** NET ppUSDC realized APY over the selected window (feed only). */
  netApyPercent: number | null;
  /** DERIVED GROSS Aave supply APY (feed only). Never substitute for net. */
  grossAaveApyPercent: number | null;
  feeBps: number | null;
  netApyWindowDays: number | null;
  /** NET realized APY samples derived from exchangeRate deltas, oldest→newest. */
  netApySeries: NetApySeriesPoint[];
  /** The same samples as display percents. */
  netApySeriesPercents: number[];
  /** Span each sample annualizes, seconds (null when the series is empty). */
  sampleWindowSeconds: number | null;
  latestObservationTimestamp: string | null;
  rateSnapshotIntervalSeconds: number | null;
  /** The share the feeds describe (ppUSDC today), lowercase hex, null until answered. */
  feedShareAddress: string | null;
};

const EMPTY_SERIES: NetApySeriesPoint[] = [];

/**
 * Vault metrics + rate history for one chain and one chart period, with the
 * NET realized APY series already derived (same methodology as the server's
 * headline figure — services/yield-feeds.ts). Everything degrades to
 * `yieldFeedsAvailable: false` + empty data while the feeds are dormant.
 */
export function useYieldFeeds(params: {
  chainId: number;
  /** Chart period; also selects the metrics window (7D→7d, 30D→30d, 3M→90d). */
  period?: ApyPeriodLabel;
  /** Upper bound on plotted samples. */
  seriesMaxPoints?: number;
}): YieldFeedsView {
  const { chainId, period = '30D', seriesMaxPoints = 60 } = params;
  // `period` now only shapes the series derived LOCALLY from snapshots we
  // already hold. It no longer reaches the network: changing the chart period
  // used to change the metrics request, which told the ASP which period this
  // user had picked.
  const window = APY_PERIOD_WINDOWS[period];
  const metrics = usePpUsdcVaultMetrics({ chainId });
  const history = usePpUsdcRateHistory({ chainId });

  const netApySeries = useMemo(() => {
    if (history.snapshots.length === 0) return EMPTY_SERIES;
    return deriveNetApySeries(history.snapshots, {
      windowSeconds: APY_WINDOW_DAYS[window] * 24 * 60 * 60,
      maxPoints: seriesMaxPoints,
    });
  }, [history.snapshots, window, seriesMaxPoints]);

  const apy = useMemo(
    () =>
      resolveYieldApy({
        feedNetApyBps: metrics.data?.netRealizedApy?.apyBps ?? null,
        feedWindowDays: metrics.netApyWindowDays,
        envApyPercent: YIELD_APY_PERCENT,
      }),
    [metrics.data, metrics.netApyWindowDays],
  );

  const available = metrics.available && history.available;
  return {
    yieldFeedsAvailable: available,
    feedShareAddress: history.data?.ppUsdcAddress?.toLowerCase() ?? null,
    isLoading: metrics.isLoading || history.isLoading,
    isError: metrics.isError || history.isError,
    // resolveYieldApy already falls back to the env placeholder (and then to
    // "omitted") when the feed carries no usable net APY, so this is correct
    // in both the available and dormant states.
    apy,
    netApyPercent: metrics.netRealizedApyPercent,
    grossAaveApyPercent: metrics.grossAaveApyPercent,
    feeBps: metrics.feeBps,
    netApyWindowDays: metrics.netApyWindowDays,
    netApySeries,
    netApySeriesPercents: netApySeriesPercents(netApySeries),
    sampleWindowSeconds: netApySeries.length > 0 ? netApySeries[netApySeries.length - 1].sampleWindowSeconds : null,
    latestObservationTimestamp: metrics.latestObservationTimestamp,
    rateSnapshotIntervalSeconds: history.intervalSeconds,
  };
}

/** Re-exported so consumers don't need two imports for the percent helper. */
export { bpsToPercent };
