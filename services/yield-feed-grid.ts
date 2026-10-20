/**
 * The yield feeds, as public-feed-grid definitions.
 *
 * WHAT THIS FIXES. The ppUSDC rate history was fetched from a component and
 * had exactly ONE trigger in the whole app: expanding a position's yield row
 * in components/portfolio/all-positions.tsx, which mounts RowYieldHistory,
 * which mounts useYieldFeeds with an `enabled:` computed from that position.
 * So the request said, by existing and by its timing, "this client just opened
 * the yield row for a position on this chain". That is the Class 2 shape in
 * .claude/skills/privacy-review/SKILL.md — an `enabled:` computed from a
 * selection — and services/public-feeds.ts already named this feed as one
 * still doing it.
 *
 * The vault metrics were milder: the Portfolio page mounted them on arrival,
 * so they said which screen, not which row. The grid fixes both, and also
 * retires a quieter tell — the chart period selected the metrics `?window=`,
 * putting a UI choice in the URL.
 *
 * On the grid, the set of feeds is a build constant: every client that loads
 * the app attempts these, on the same wall-clock cadence, whatever the user
 * then does. Expanding a row becomes a pure read of a cache that was going to
 * be filled anyway.
 *
 * YIELD EARNED (2026-09-24). The portfolio's earned figure (SDK
 * `PoolSessionYieldEarned`, v2-monorepo#431) needs two more feeds, both here:
 * the chain's whole yield-deposits feed (the exact cost basis of an own
 * deposit) and the rate history of EVERY configured share, asked for by
 * `?asset=<share>`. The share list is build config, so each chain asks for
 * every share it configures whether or not this wallet holds any; asking only
 * for held shares would say which ones it holds. The deposits feed is fetched
 * whole and narrowed locally, never filtered by commitment.
 *
 * WHY THE HISTORY ACCUMULATES. It is an append-only log — 68 KB on mainnet
 * today, one row longer every hour, forever. Re-draining it on every tick
 * would make a privacy fix cost every user a growing download. The feed is
 * paginated by an opaque server row id, so a tick soon after the last one
 * resumes; see services/yield-feed-accumulator.ts for when that is allowed and
 * why a stale cursor is not.
 *
 * A dormant feed (404 on a chain with no yield token configured — today that
 * is Citrea, Optimism, Sepolia and all of staging) is `{status:'unavailable'}`,
 * not an error, and stays that way until the deployment appears. The grid
 * keeps probing on its own cadence, which is what a component-mounted query
 * needed a bespoke `refetchInterval` to achieve.
 *
 * APP-ONLY MODULE: reaches the api client. Bun tests import
 * services/yield-feed-accumulator.ts instead, which is pure.
 */
import apiClient from '@/services/api-client';
import type {
  PpUsdcApyWindow,
  PpUsdcRateHistoryResponse,
  PpUsdcRateSnapshot,
  PpUsdcVaultMetricsResponse,
  YieldDepositFact,
  YieldDepositsResponse,
} from '@/services/api-types';
import {
  drainYieldFeedPages,
  loadYieldFeed,
  type YieldFeedResult,
} from '@/services/yield-feeds';
import {
  cursorWasInvalidated,
  EMPTY_YIELD_FEED_ACCUMULATOR,
  mergeYieldFeedRows,
  resumePoint,
  type YieldFeedAccumulator,
} from '@/services/yield-feed-accumulator';

export const feedPpUsdcRateHistory = (chainId: number | string) => `ppusdc-rate-history:${chainId}`;
export const feedPpUsdcVaultMetrics = (chainId: number | string) => `ppusdc-vault-metrics:${chainId}`;
/** One share's rate history on one chain (`?asset=<share>`), for yield earned. */
export const feedYieldRateHistory = (chainId: number | string, share: string) => `yield-rate-history:${chainId}:${share.toLowerCase()}`;
/** The chain's whole yield-deposits feed, for yield earned. */
export const feedYieldDeposits = (chainId: number | string) => `yield-deposits:${chainId}`;

/**
 * The window the metrics feed is fetched with. Fixed, and stated rather than
 * defaulted: a per-caller window would put the user's chart period into the
 * request, which is the thing this module exists to stop.
 */
export const GRID_APY_WINDOW: PpUsdcApyWindow = '30d';

/** The cadence public-feeds.ts registers the history at; the resume rule needs it. */
export const RATE_HISTORY_INTERVAL_MS = 10 * 60_000;
/** Same cadence for the deposits feed: it moves when a yield deposit lands. */
export const YIELD_DEPOSITS_INTERVAL_MS = 10 * 60_000;

const rateAccumulators = new Map<string, YieldFeedAccumulator<PpUsdcRateSnapshot>>();
const depositAccumulators = new Map<string, YieldFeedAccumulator<YieldDepositFact>>();

/** Test seam: drop retained rows so one case cannot leak into the next. */
export function resetYieldFeedAccumulators(): void {
  rateAccumulators.clear();
  depositAccumulators.clear();
}

/**
 * ppUSDC assets-per-share history for a chain, accumulated across ticks.
 *
 * The ONLY request parameters are the chain (build config) and, when resuming
 * is allowed, the server's own cursor from the previous tick. Never a block, a
 * timestamp, a commitment or a label, and never an early stop once some note
 * of ours is covered — the whole feed, always. A later "only fetch what this
 * user needs" optimisation here would reintroduce exactly the leak this file
 * removed.
 */
export async function fetchPpUsdcRateHistoryFeed(
  chainId: number,
  now: number = Date.now(),
): Promise<YieldFeedResult<PpUsdcRateHistoryResponse>> {
  return accumulateRateHistory(chainId, undefined, now);
}

/**
 * One configured share's rate history, same accumulation as above. The only
 * extra parameter is the share address, which is build config: every client
 * of this build asks for the same list of shares.
 */
export async function fetchYieldRateHistoryFeed(
  chainId: number,
  share: string,
  now: number = Date.now(),
): Promise<YieldFeedResult<PpUsdcRateHistoryResponse>> {
  return accumulateRateHistory(chainId, share.toLowerCase(), now);
}

async function accumulateRateHistory(
  chainId: number,
  asset: string | undefined,
  now: number,
): Promise<YieldFeedResult<PpUsdcRateHistoryResponse>> {
  const key = asset ? `${chainId}:${asset}` : String(chainId);
  return loadYieldFeed(async (): Promise<PpUsdcRateHistoryResponse> => {
    // A client that missed ticks must not send a cursor nobody else sends. A
    // capped prefix resumes under the same rule, or it would never converge.
    const prev = resumePoint(rateAccumulators.get(key), now, RATE_HISTORY_INTERVAL_MS);

    const drained = await drainYieldFeedPages<PpUsdcRateHistoryResponse, PpUsdcRateSnapshot>({
      fetchPage: (cursor) => apiClient.getPpUsdcRateHistory(chainId, cursor, asset),
      rowsOf: (page) => page.snapshots,
      cursorOf: (page) => page.lastSyncedId,
      sinceId: prev.lastSyncedId ?? undefined,
    });

    // The server reused its ids: what we hold describes a feed that no longer
    // exists, so keeping it would merge each observation twice.
    const base = cursorWasInvalidated({ cursor: prev.lastSyncedId, incoming: drained.rows, idOf: (r) => r.id })
      ? (EMPTY_YIELD_FEED_ACCUMULATOR as YieldFeedAccumulator<PpUsdcRateSnapshot>)
      : prev;

    // A truncated drain still MERGES, so the cursor advances and the next tick
    // continues. Without this a feed past the page cap would re-fetch the same
    // 25 pages every tick and never converge. It is not published: `complete`
    // stays false and the throw below keeps it out of the cache.
    const merged = mergeYieldFeedRows({
      prev: base,
      incoming: drained.rows,
      lastSyncedId: drained.lastSyncedId,
      idOf: (row) => row.id,
      // An observation is identified in the world by the block it was taken at.
      keyOf: (row) => row.observationBlock,
      complete: drained.reason === 'complete',
      now,
    });
    // A stalled cursor is not a prefix to resume: forget it so the next tick
    // bootstraps like a fresh client. Only a page-capped drain resumes.
    if (drained.reason === 'stalled') rateAccumulators.delete(key);
    else rateAccumulators.set(key, merged);

    if (!merged.complete) {
      throw new Error(`yield feed drain incomplete (${drained.reason})`);
    }
    return { ...drained.page, snapshots: [...merged.rows], lastSyncedId: merged.lastSyncedId ?? drained.lastSyncedId };
  });
}

/**
 * The chain's whole yield-deposits feed, accumulated the same way. No filter:
 * no asset, no commitment, no block. Every share's rows arrive and the
 * consumer keeps the ones of the share it values.
 */
export async function fetchYieldDepositsFeed(
  chainId: number,
  now: number = Date.now(),
): Promise<YieldFeedResult<YieldDepositsResponse>> {
  const key = String(chainId);
  return loadYieldFeed(async (): Promise<YieldDepositsResponse> => {
    const prev = resumePoint(depositAccumulators.get(key), now, YIELD_DEPOSITS_INTERVAL_MS);

    const drained = await drainYieldFeedPages<YieldDepositsResponse, YieldDepositFact>({
      fetchPage: (cursor) => apiClient.getYieldDeposits(chainId, cursor),
      rowsOf: (page) => page.deposits,
      cursorOf: (page) => page.lastSyncedId,
      sinceId: prev.lastSyncedId ?? undefined,
    });

    const base = cursorWasInvalidated({ cursor: prev.lastSyncedId, incoming: drained.rows, idOf: (r) => r.id })
      ? (EMPTY_YIELD_FEED_ACCUMULATOR as YieldFeedAccumulator<YieldDepositFact>)
      : prev;

    const merged = mergeYieldFeedRows({
      prev: base,
      incoming: drained.rows,
      lastSyncedId: drained.lastSyncedId,
      idOf: (row) => row.id,
      // A deposit is identified in the world by its log. A duplicated fact is
      // a doubled cost basis.
      keyOf: (row) => `${row.txHash.toLowerCase()}:${row.logIndex}`,
      complete: drained.reason === 'complete',
      now,
    });
    if (drained.reason === 'stalled') depositAccumulators.delete(key);
    else depositAccumulators.set(key, merged);

    if (!merged.complete) {
      throw new Error(`yield feed drain incomplete (${drained.reason})`);
    }
    return { deposits: [...merged.rows], lastSyncedId: merged.lastSyncedId ?? drained.lastSyncedId };
  });
}

/** Current vault metrics for a chain. A snapshot, so no accumulation. */
export async function fetchPpUsdcVaultMetricsFeed(
  chainId: number,
): Promise<YieldFeedResult<PpUsdcVaultMetricsResponse>> {
  return loadYieldFeed(() => apiClient.getPpUsdcVaultMetrics(chainId, GRID_APY_WINDOW));
}
