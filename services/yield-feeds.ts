// Pure helpers for the public ppUSDC yield feeds (asp-v2 PR #90 / issue #89).
// No React / react-query / api-client imports — unit-tested in
// services/__tests__/yield-feeds.test.ts. hooks/use-yield-feeds.ts is the
// react-query layer on top.
//
// ── NET vs GROSS (read before touching any APY here) ──────────────────────
// The feeds expose TWO different APYs and they are NOT interchangeable:
//   • NET ppUSDC realized APY — annualized (compounded) growth of the vault's
//     assets-per-share (PPYieldToken.exchangeRate) over a trailing window:
//     what a ppUSDC holder actually earned, AFTER the protocol yield fee.
//   • GROSS Aave supply APY — the same yield BEFORE the fee, derived as
//     gross = net / (1 − feeBps).
// Every display must say which one it is. The math below mirrors
// apps/api-gateway/src/utils/yield-apy.util.ts on
// asp-v2@feat/yield-portfolio-data verbatim (same formula, same bps rounding,
// same null-on-degenerate-input rules) so client-derived series and the
// server's headline figure can never disagree methodologically.
// ─────────────────────────────────────────────────────────────────────────

import type {
  PpUsdcApyWindow,
  PpUsdcRateSnapshot,
  PpUsdcVaultMetricsResponse,
} from '@/services/api-types';

/** Seconds in a year — the annualization base (parity with the ASP util). */
export const YEAR_SECONDS = 365 * 24 * 60 * 60;

/**
 * HTTP status the feeds answer with while the chain has no yield pool
 * configured. The three endpoints are config-gated dormant server-side, so a
 * 404 is the NORMAL "not deployed yet" answer — never an error to surface.
 */
export const YIELD_FEED_UNAVAILABLE_STATUS = 404;

/**
 * True when `error` is the feeds' "not configured on this chain" answer.
 * Duck-typed on APIError.statusCode (services/api-client.ts:25-34) so this
 * module stays import-free and testable without the client/env.
 */
export function isYieldFeedUnavailableError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  return (error as { statusCode?: unknown }).statusCode === YIELD_FEED_UNAVAILABLE_STATUS;
}

export type YieldFeedResult<T> = { status: 'ok'; value: T } | { status: 'unavailable' };

/**
 * Runs a feed request and folds the dormant-feed 404 into a clean
 * `{ status: 'unavailable' }` value. REAL failures (network, 5xx, malformed
 * body) still throw, so react-query can retry/report them normally.
 */
export async function loadYieldFeed<T>(load: () => Promise<T>): Promise<YieldFeedResult<T>> {
  try {
    return { status: 'ok', value: await load() };
  } catch (error) {
    if (isYieldFeedUnavailableError(error)) return { status: 'unavailable' };
    throw error;
  }
}

// ── Feed pagination (asp-v2@5f6b522, PR #90 review fixes) ────────────────
//
// The deposit-facts and rate-history feeds are PAGED: the server returns at
// most YIELD_FEED_PAGE_SIZE rows per response and `lastSyncedId` is the id of
// the LAST ROW RETURNED (no longer the feed head). A single fetch of a feed
// longer than one page would therefore silently hold only the OLDEST page —
// the chart's "latest" observations would be stale history. Every bootstrap
// must drain pages until the feed says caught-up.

/**
 * The server's page cap (PublicService.YIELD_FEED_PAGE_SIZE on
 * asp-v2@feat/yield-portfolio-data). Documentation only — the drain below
 * deliberately does NOT use it as a stop signal, so a server-side page-size
 * change can never make the client drop rows.
 */
export const YIELD_FEED_PAGE_SIZE = 1000;

/**
 * Drain guard: at most this many pages per drain (25 × 1000-row pages = 25k
 * rows), so a runaway feed — or a buggy cursor — can never turn one query
 * into an unbounded request storm.
 */
export const YIELD_FEED_MAX_PAGES = 25;

/** Why a drain stopped. Only 'complete' may be published as a healthy feed. */
export type YieldFeedDrainReason = 'complete' | 'max-pages' | 'stalled';

export type DrainedYieldFeed<TPage, TRow> = {
  /** Why the drain stopped — anything but 'complete' is a partial feed. */
  reason: YieldFeedDrainReason;
  /** The last page fetched — carries the non-row envelope fields verbatim. */
  page: TPage;
  /** Every row across all pages, in server order (id ascending). */
  rows: TRow[];
  /** Cursor after the drain — the resume point a future poll passes as `sinceId`. */
  lastSyncedId: string;
  /** True when YIELD_FEED_MAX_PAGES stopped the drain before an empty page. */
  truncated: boolean;
};

/**
 * Fetches feed pages until caught-up: an EMPTY page is the only data-driven
 * stop (a "short page < page size" heuristic would drop rows if the server
 * ever shrank its page size), guarded by a non-advancing-cursor check and the
 * YIELD_FEED_MAX_PAGES cap. Also compatible with the pre-pagination protocol
 * (one all-rows page whose lastSyncedId is the head): the follow-up request
 * comes back empty and the drain stops. Errors (including the dormant-feed
 * 404) propagate to the caller — run the drain inside loadYieldFeed().
 */
export async function drainYieldFeedPages<TPage, TRow>(params: {
  fetchPage: (sinceId: string | undefined) => Promise<TPage>;
  rowsOf: (page: TPage) => readonly TRow[];
  cursorOf: (page: TPage) => string;
  /** Resume point from a previous drain; omit to bootstrap from the start. */
  sinceId?: string;
  maxPages?: number;
}): Promise<DrainedYieldFeed<TPage, TRow>> {
  const maxPages = Math.max(1, Math.floor(params.maxPages ?? YIELD_FEED_MAX_PAGES));
  let cursor = params.sinceId;
  const rows: TRow[] = [];
  let page = await params.fetchPage(cursor);
  let pageRows = params.rowsOf(page);
  rows.push(...pageRows);
  let pages = 1;
  let reason: YieldFeedDrainReason = 'complete';
  while (pageRows.length > 0) {
    // Post-5f6b522 protocol: pages are capped at YIELD_FEED_PAGE_SIZE rows and
    // a SHORT page means caught up — stopping here (rather than probing for an
    // empty page) both saves a request per drain and, more importantly, means
    // a transient failure on that pointless probe can no longer throw away a
    // fully drained feed. A page LARGER than the cap can only be the old
    // unpaginated protocol, which returns everything at once — also complete.
    // Exactly PAGE_SIZE rows is the one ambiguous case and needs another page.
    // (If the server ever REDUCES its page size, a full mid-feed page would
    // read as short and end the drain early — that is a protocol change and
    // gets caught by the backend mirror tests, not silently papered over.)
    if (pageRows.length !== YIELD_FEED_PAGE_SIZE) break;
    const next = params.cursorOf(page);
    // A non-advancing or REGRESSING cursor can only be a server bug; keeping
    // going would refetch the same rows forever (or ping-pong between two
    // cursors, which plain equality would miss). Numeric compare when both
    // sides are numeric — these ids are decimal strings.
    if (!next || !advances(next, cursor)) {
      reason = 'stalled';
      break;
    }
    if (pages >= maxPages) {
      reason = 'max-pages';
      break;
    }
    cursor = next;
    page = await params.fetchPage(cursor);
    pageRows = params.rowsOf(page);
    rows.push(...pageRows);
    pages += 1;
  }
  return {
    page,
    rows,
    lastSyncedId: params.cursorOf(page),
    reason,
    truncated: reason !== 'complete',
  };
}

/** Did the cursor move strictly FORWARD? Numeric when possible, else inequality. */
function advances(next: string, cursor: string | undefined): boolean {
  if (cursor === undefined) return true;
  if (/^\d+$/.test(next) && /^\d+$/.test(cursor)) {
    try {
      return BigInt(next) > BigInt(cursor);
    } catch {
      return next !== cursor;
    }
  }
  return next !== cursor;
}

/**
 * Annualized (compounded) growth of assets-per-share between two observations,
 * in basis points. null when the inputs can't yield a rate (non-positive rate,
 * zero/negative elapsed time, non-finite result) — exactly the ASP util's
 * contract. This is the NET ppUSDC realized APY; the fee is already inside the
 * exchangeRate.
 */
export function netRealizedApyBps(params: {
  fromRate: string | number;
  toRate: string | number;
  fromMs: number;
  toMs: number;
}): number | null {
  const from = Number(params.fromRate);
  const to = Number(params.toRate);
  const elapsedSeconds = (params.toMs - params.fromMs) / 1000;
  if (!(from > 0) || !(to > 0) || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return null;
  const apy = Math.pow(to / from, YEAR_SECONDS / elapsedSeconds) - 1;
  if (!Number.isFinite(apy)) return null;
  return Math.round(apy * 10_000);
}

/**
 * GROSS Aave supply APY from the net realized APY and the on-chain protocol
 * fee: gross = net / (1 − feeBps/10000). null when either input is missing or
 * the fee is degenerate (<0 or ≥100%). Parity with the ASP util.
 */
export function grossAaveApyBps(netBps: number | null, feeBps: number | null): number | null {
  if (netBps == null || feeBps == null) return null;
  const feeFraction = feeBps / 10_000;
  if (feeFraction >= 1 || feeFraction < 0) return null;
  return Math.round(netBps / (1 - feeFraction));
}

/** Basis points → display percent (324 bps → 3.24). null passes through. */
export function bpsToPercent(bps: number | null | undefined): number | null {
  if (bps == null || !Number.isFinite(bps)) return null;
  return bps / 100;
}

/** The vault feed's NET ppUSDC realized APY as a percent (null = unavailable). */
export function netRealizedApyPercent(
  metrics: PpUsdcVaultMetricsResponse | undefined,
): number | null {
  return bpsToPercent(metrics?.netRealizedApy?.apyBps ?? null);
}

/**
 * The vault feed's DERIVED GROSS Aave supply APY as a percent. Deliberately a
 * separate function from netRealizedApyPercent — never swap one for the other.
 */
export function grossAaveApyPercent(
  metrics: PpUsdcVaultMetricsResponse | undefined,
): number | null {
  return bpsToPercent(metrics?.grossAaveApy?.apyBps ?? null);
}

// ── Headline APY resolution ──────────────────────────────────────────────

/**
 * Where a displayed APY came from:
 *   'ppusdc-net-realized' — the feed's NET ppUSDC realized APY (real).
 *   'env-placeholder'     — the static EXPO_PUBLIC_YIELD_APY value.
 * A null source means UNAVAILABLE: the number is omitted (config/yield.ts
 * policy). There is no gross-APY headline: the surfaces show what a holder
 * earns, and mixing the two would misreport yield.
 */
export type YieldApySource = 'ppusdc-net-realized' | 'env-placeholder';

export type ResolvedYieldApy = {
  /** Percent to display, or null = unavailable → render the label with no number. */
  percent: number | null;
  source: YieldApySource | null;
  /** Trailing window of the realized figure (feed source only). */
  windowDays: number | null;
};

export const UNAVAILABLE_YIELD_APY: ResolvedYieldApy = {
  percent: null,
  source: null,
  windowDays: null,
};

/**
 * Headline APY precedence: the feed's NET realized APY when available, else the
 * static env placeholder, else unavailable (omit the number). The caller keeps
 * `source` so the UI can label a real figure as the net realized APY instead of
 * passing it off as Aave's gross supply APY.
 */
export function resolveYieldApy(params: {
  feedNetApyBps: number | null | undefined;
  feedWindowDays?: number | null;
  envApyPercent: number | null;
}): ResolvedYieldApy {
  const feedPercent = bpsToPercent(params.feedNetApyBps ?? null);
  if (feedPercent !== null) {
    return {
      percent: feedPercent,
      source: 'ppusdc-net-realized',
      windowDays: params.feedWindowDays ?? null,
    };
  }
  if (params.envApyPercent !== null && Number.isFinite(params.envApyPercent)) {
    return { percent: params.envApyPercent, source: 'env-placeholder', windowDays: null };
  }
  return UNAVAILABLE_YIELD_APY;
}

// ── Rate-history → net realized APY series ───────────────────────────────

/** Chart period label → the feed's trailing window param. */
export const APY_PERIOD_WINDOWS: Record<'7D' | '30D' | '3M', PpUsdcApyWindow> = {
  '7D': '7d',
  '30D': '30d',
  '3M': '90d',
};

export type ApyPeriodLabel = keyof typeof APY_PERIOD_WINDOWS;

/** Display order of the chart's period switcher. */
export const APY_PERIOD_LABELS: readonly ApyPeriodLabel[] = ['7D', '30D', '3M'];

export const APY_WINDOW_DAYS: Record<PpUsdcApyWindow, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

/** Minimal shape the series derivation needs from a rate snapshot. */
export type RateObservation = Pick<PpUsdcRateSnapshot, 'exchangeRate' | 'observationTimestamp'>;

export type NetApySeriesPoint = {
  /** Right edge of the sample (the newer observation), ms epoch. */
  timestampMs: number;
  /** NET ppUSDC realized APY over this sample's span, basis points. */
  netApyBps: number;
  /** Span the sample annualizes, seconds (methodology, for labelling). */
  sampleWindowSeconds: number;
};

/** A snapshot reduced to the two numbers the rate math needs. */
export type ParsedRateObservation = { rate: number; tsMs: number };

/** Parses + sorts raw snapshots, dropping rows that can't carry rate math. */
export function parseRateObservations(
  snapshots: readonly RateObservation[],
): ParsedRateObservation[] {
  const parsed: ParsedRateObservation[] = [];
  for (const snapshot of snapshots) {
    const rate = Number(snapshot.exchangeRate);
    const tsMs = Date.parse(snapshot.observationTimestamp);
    if (!(rate > 0) || !Number.isFinite(tsMs)) continue;
    parsed.push({ rate, tsMs });
  }
  parsed.sort((a, b) => a.tsMs - b.tsMs);
  return parsed;
}

/**
 * NET ppUSDC realized APY series over the trailing `windowSeconds`, at most
 * `maxPoints` samples, derived from exchangeRate deltas with the SAME
 * methodology as the server's headline figure (annualized compounded growth) —
 * only the span differs: each plotted sample annualizes one stride of
 * observations, so the chart shows realized-APY movement inside the window
 * rather than one number. Samples are taken newest-first (the head is always
 * plotted) and returned oldest→newest; each carries its own span so the UI can
 * label the methodology honestly. A stride shorter than the snapshot cadence
 * would annualize rounding noise — the stride is never below one observation
 * gap by construction.
 */
export function deriveNetApySeries(
  snapshots: readonly RateObservation[],
  opts: { windowSeconds: number; maxPoints: number },
): NetApySeriesPoint[] {
  const observations = parseRateObservations(snapshots);
  if (observations.length < 2) return [];
  const latestMs = observations[observations.length - 1].tsMs;
  const windowStartMs = latestMs - Math.max(1, opts.windowSeconds) * 1000;
  const inWindow = observations.filter((o) => o.tsMs >= windowStartMs);
  if (inWindow.length < 2) return [];

  const maxPoints = Math.max(1, Math.floor(opts.maxPoints));
  const stride = Math.max(1, Math.ceil((inWindow.length - 1) / maxPoints));
  const points: NetApySeriesPoint[] = [];
  for (let i = inWindow.length - 1; i - stride >= 0 && points.length < maxPoints; i -= stride) {
    const to = inWindow[i];
    const from = inWindow[i - stride];
    const netApyBps = netRealizedApyBps({
      fromRate: from.rate,
      toRate: to.rate,
      fromMs: from.tsMs,
      toMs: to.tsMs,
    });
    if (netApyBps === null) continue;
    points.push({
      timestampMs: to.tsMs,
      netApyBps,
      sampleWindowSeconds: (to.tsMs - from.tsMs) / 1000,
    });
  }
  return points.reverse();
}

/** Series as display percents, oldest→newest (empty when nothing is derivable). */
export function netApySeriesPercents(points: readonly NetApySeriesPoint[]): number[] {
  return points.map((p) => p.netApyBps / 100);
}

/**
 * Compact label for a sample's span ("45m" / "6h" / "3d"), so the chart can
 * state WHAT each plotted point annualizes instead of implying it is the same
 * trailing figure as the headline APY. null when there is no span to describe.
 */
export function formatSampleSpan(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60 * 60) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 48 * 60 * 60) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

/**
 * A drain that stopped for ANY reason but 'complete' is a partial feed —
 * publishing it as ok is exactly the stale-chart bug the drain exists to
 * prevent (the page cap or a stalled cursor would otherwise surface the OLDEST
 * rows as if current, and a bootstrap refetch never recovers the suffix).
 * Throwing turns it into a real failure: visible, never silently wrong data.
 *
 * Lives here rather than in the hook because the public-feed grid drains these
 * feeds too, and a second private copy is how the two would drift.
 */
export function requireCompleteDrain<T extends { reason: string }>(drained: T): T {
  if (drained.reason !== 'complete') {
    throw new Error(`yield feed drain incomplete (${drained.reason})`);
  }
  return drained;
}
