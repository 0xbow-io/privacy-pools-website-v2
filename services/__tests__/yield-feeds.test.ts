// Public ppUSDC yield feeds (asp-v2 PR #90 / issue #89).
//
// Two things are pinned here:
//  1. APY parity with the server's derivation
//     (apps/api-gateway/src/utils/yield-apy.util.ts + its .spec.ts on
//     asp-v2@feat/yield-portfolio-data) — the client must not invent its own
//     methodology, and NET must never be confused with GROSS.
//  2. The dormant-feed contract: a 404 ("no yield pool configured on this
//     chain") is an UNAVAILABLE state, not an error.

import { describe, expect, test } from 'bun:test';

import {
  APY_PERIOD_WINDOWS,
  APY_WINDOW_DAYS,
  bpsToPercent,
  deriveNetApySeries,
  drainYieldFeedPages,
  formatSampleSpan,
  grossAaveApyBps,
  grossAaveApyPercent,
  isYieldFeedUnavailableError,
  loadYieldFeed,
  netApySeriesPercents,
  netRealizedApyBps,
  netRealizedApyPercent,
  parseRateObservations,
  resolveYieldApy,
  UNAVAILABLE_YIELD_APY,
  YEAR_SECONDS,
  YIELD_FEED_UNAVAILABLE_STATUS,
  type RateObservation,
} from '../yield-feeds';
import type { PpUsdcVaultMetricsResponse } from '../api-types';

// Mirrors services/api-client.ts's APIError surface (statusCode/statusText/url).
class FakeAPIError extends Error {
  constructor(
    public statusCode: number,
    public statusText = 'Not Found',
    public url = 'https://asp/11155111/public/ppusdc-vault-metrics',
  ) {
    super(`API request failed: ${statusCode} ${statusText} (${url})`);
    this.name = 'APIError';
  }
}

const HOUR_MS = 60 * 60 * 1000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Hourly snapshots compounding at a fixed per-hour growth factor. */
function hourlySnapshots(count: number, startRate: number, perHourGrowth: number): RateObservation[] {
  const startMs = Date.UTC(2026, 0, 1);
  const out: RateObservation[] = [];
  let rate = startRate;
  for (let i = 0; i < count; i++) {
    out.push({ exchangeRate: String(Math.round(rate)), observationTimestamp: iso(startMs + i * HOUR_MS) });
    rate *= perHourGrowth;
  }
  return out;
}

describe('netRealizedApyBps (parity with asp-v2 yield-apy.util.spec.ts)', () => {
  const day = (n: number) => Date.UTC(2026, 0, 1 + n);

  test('annualizes a one-year 5% growth to ~500 bps', () => {
    expect(
      netRealizedApyBps({ fromRate: '1000000', toRate: '1050000', fromMs: 0, toMs: YEAR_SECONDS * 1000 }),
    ).toBe(500);
  });

  test('compounds a 30-day growth to an annualized figure larger than the raw growth', () => {
    const bps = netRealizedApyBps({ fromRate: '1000000', toRate: '1005000', fromMs: day(0), toMs: day(30) });
    expect(bps).not.toBeNull();
    expect(bps!).toBeGreaterThan(500);
  });

  test('null when elapsed time is zero or negative', () => {
    expect(netRealizedApyBps({ fromRate: '1000000', toRate: '1050000', fromMs: day(5), toMs: day(5) })).toBeNull();
    expect(netRealizedApyBps({ fromRate: '1000000', toRate: '1050000', fromMs: day(5), toMs: day(1) })).toBeNull();
  });

  test('null for non-positive / unparseable rates', () => {
    expect(netRealizedApyBps({ fromRate: '0', toRate: '1050000', fromMs: day(0), toMs: day(30) })).toBeNull();
    expect(netRealizedApyBps({ fromRate: 'abc', toRate: '1050000', fromMs: day(0), toMs: day(30) })).toBeNull();
    expect(netRealizedApyBps({ fromRate: '1000000', toRate: '-5', fromMs: day(0), toMs: day(30) })).toBeNull();
  });

  test('negative when the share price falls (a loss is reported, not clamped)', () => {
    expect(
      netRealizedApyBps({ fromRate: '1000000', toRate: '990000', fromMs: 0, toMs: YEAR_SECONDS * 1000 }),
    ).toBe(-100);
  });
});

describe('grossAaveApyBps (gross = net / (1 − feeBps); NOT interchangeable with net)', () => {
  test('grosses net up by the fee', () => {
    expect(grossAaveApyBps(450, 1000)).toBe(500);
  });

  test('equals net only when the fee is zero', () => {
    expect(grossAaveApyBps(500, 0)).toBe(500);
    expect(grossAaveApyBps(500, 1000)).not.toBe(500);
  });

  test('null when net or fee is missing, or the fee is degenerate', () => {
    expect(grossAaveApyBps(null, 1000)).toBeNull();
    expect(grossAaveApyBps(500, null)).toBeNull();
    expect(grossAaveApyBps(500, 10_000)).toBeNull();
    expect(grossAaveApyBps(500, -1)).toBeNull();
  });
});

describe('bpsToPercent', () => {
  test('bps → percent', () => {
    expect(bpsToPercent(324)).toBe(3.24);
    expect(bpsToPercent(0)).toBe(0);
    expect(bpsToPercent(-100)).toBe(-1);
  });

  test('null/undefined/non-finite stay unavailable', () => {
    expect(bpsToPercent(null)).toBeNull();
    expect(bpsToPercent(undefined)).toBeNull();
    expect(bpsToPercent(Number.NaN)).toBeNull();
  });
});

describe('vault-metrics accessors keep NET and GROSS apart', () => {
  const metrics: PpUsdcVaultMetricsResponse = {
    chainId: '11155111',
    ppUsdcAddress: '0xppusdc',
    latest: {
      exchangeRate: '1010000',
      shareDecimals: 6,
      assetDecimals: 6,
      observationBlock: '123',
      observationTimestamp: iso(Date.UTC(2026, 0, 31)),
    },
    netRealizedApy: {
      apyBps: 450,
      windowDays: 30,
      methodology: 'annualized (compounded) growth of ppUSDC exchangeRate over the window',
      fromBlock: '1',
      fromTimestamp: iso(Date.UTC(2026, 0, 1)),
      toBlock: '123',
      toTimestamp: iso(Date.UTC(2026, 0, 31)),
    },
    grossAaveApy: { apyBps: 500, feeBps: 1000, source: 'derived', methodology: 'net / (1 − feeBps)' },
  };

  test('net accessor reads netRealizedApy, gross accessor reads grossAaveApy', () => {
    expect(netRealizedApyPercent(metrics)).toBe(4.5);
    expect(grossAaveApyPercent(metrics)).toBe(5);
  });

  test('undefined metrics (dormant feed) → both unavailable', () => {
    expect(netRealizedApyPercent(undefined)).toBeNull();
    expect(grossAaveApyPercent(undefined)).toBeNull();
  });

  test('a configured-but-empty vault (no snapshot yet) → both unavailable, never 0%', () => {
    const empty: PpUsdcVaultMetricsResponse = {
      ...metrics,
      latest: null,
      netRealizedApy: { ...metrics.netRealizedApy, apyBps: null },
      grossAaveApy: { ...metrics.grossAaveApy, apyBps: null, feeBps: null },
    };
    expect(netRealizedApyPercent(empty)).toBeNull();
    expect(grossAaveApyPercent(empty)).toBeNull();
  });
});

describe('resolveYieldApy (feed net → env placeholder → omitted)', () => {
  test('feed net APY wins and is labelled as the net realized figure', () => {
    expect(resolveYieldApy({ feedNetApyBps: 437, feedWindowDays: 30, envApyPercent: 3.24 })).toEqual({
      percent: 4.37,
      source: 'ppusdc-net-realized',
      windowDays: 30,
    });
  });

  test('falls back to the env placeholder when the feed carries no net APY', () => {
    expect(resolveYieldApy({ feedNetApyBps: null, envApyPercent: 3.24 })).toEqual({
      percent: 3.24,
      source: 'env-placeholder',
      windowDays: null,
    });
    expect(resolveYieldApy({ feedNetApyBps: undefined, envApyPercent: 3.24 }).source).toBe('env-placeholder');
  });

  test('nothing configured → UNAVAILABLE (number omitted, never fabricated)', () => {
    expect(resolveYieldApy({ feedNetApyBps: null, envApyPercent: null })).toEqual(UNAVAILABLE_YIELD_APY);
    expect(resolveYieldApy({ feedNetApyBps: null, envApyPercent: null }).percent).toBeNull();
  });

  test('a real 0% net APY is still real (not treated as missing)', () => {
    expect(resolveYieldApy({ feedNetApyBps: 0, envApyPercent: 3.24 })).toEqual({
      percent: 0,
      source: 'ppusdc-net-realized',
      windowDays: null,
    });
  });
});

describe('parseRateObservations', () => {
  test('sorts ascending and drops unusable rows', () => {
    const parsed = parseRateObservations([
      { exchangeRate: '1000200', observationTimestamp: iso(2_000) },
      { exchangeRate: '1000000', observationTimestamp: iso(1_000) },
      { exchangeRate: '0', observationTimestamp: iso(3_000) },
      { exchangeRate: 'nope', observationTimestamp: iso(4_000) },
      { exchangeRate: '1000300', observationTimestamp: 'not-a-date' },
    ]);
    expect(parsed).toEqual([
      { rate: 1000000, tsMs: 1_000 },
      { rate: 1000200, tsMs: 2_000 },
    ]);
  });
});

describe('deriveNetApySeries (exchangeRate deltas → NET realized APY samples)', () => {
  test('empty / single-observation history yields no series (never a flat fake line)', () => {
    expect(deriveNetApySeries([], { windowSeconds: 30 * 86400, maxPoints: 30 })).toEqual([]);
    expect(
      deriveNetApySeries(hourlySnapshots(1, 1_000_000, 1.00001), { windowSeconds: 30 * 86400, maxPoints: 30 }),
    ).toEqual([]);
  });

  test('caps the sample count and returns samples oldest→newest', () => {
    const series = deriveNetApySeries(hourlySnapshots(200, 1_000_000, 1.0000057), {
      windowSeconds: 30 * 86400,
      maxPoints: 10,
    });
    expect(series.length).toBeGreaterThan(0);
    expect(series.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < series.length; i++) {
      expect(series[i].timestampMs).toBeGreaterThan(series[i - 1].timestampMs);
    }
  });

  test('the newest observation is always the last sample (the head is plotted)', () => {
    const snapshots = hourlySnapshots(50, 1_000_000, 1.00001);
    const series = deriveNetApySeries(snapshots, { windowSeconds: 30 * 86400, maxPoints: 7 });
    const newestMs = Date.parse(snapshots[snapshots.length - 1].observationTimestamp);
    expect(series[series.length - 1].timestampMs).toBe(newestMs);
  });

  test('constant hourly growth annualizes to a steady positive APY on the same methodology', () => {
    // +0.001%/h compounds to ~9.2%/yr; every sample must land near that and
    // match a direct netRealizedApyBps call over the same span.
    const snapshots = hourlySnapshots(100, 1_000_000_000, 1.00001);
    const series = deriveNetApySeries(snapshots, { windowSeconds: 30 * 86400, maxPoints: 10 });
    for (const point of series) {
      expect(point.netApyBps).toBeGreaterThan(800);
      expect(point.netApyBps).toBeLessThan(1000);
      expect(point.sampleWindowSeconds).toBeGreaterThan(0);
    }
    const head = series[series.length - 1];
    const direct = netRealizedApyBps({
      fromRate: '1000000000',
      toRate: String(Math.round(1_000_000_000 * Math.pow(1.00001, head.sampleWindowSeconds / 3600))),
      fromMs: 0,
      toMs: head.sampleWindowSeconds * 1000,
    });
    expect(Math.abs(head.netApyBps - direct!)).toBeLessThan(20);
  });

  test('a falling share price yields negative samples (losses are shown)', () => {
    const series = deriveNetApySeries(hourlySnapshots(48, 1_000_000_000, 0.99999), {
      windowSeconds: 7 * 86400,
      maxPoints: 6,
    });
    expect(series.length).toBeGreaterThan(0);
    expect(series.every((p) => p.netApyBps < 0)).toBe(true);
  });

  test('observations older than the window are excluded', () => {
    // 40 days of daily snapshots, 7d window → only the last week is sampled.
    const startMs = Date.UTC(2026, 0, 1);
    const snapshots: RateObservation[] = [];
    for (let i = 0; i < 40; i++) {
      snapshots.push({
        exchangeRate: String(1_000_000 + i * 100),
        observationTimestamp: iso(startMs + i * 24 * HOUR_MS),
      });
    }
    const series = deriveNetApySeries(snapshots, { windowSeconds: 7 * 86400, maxPoints: 30 });
    const cutoff = startMs + (39 - 7) * 24 * HOUR_MS;
    expect(series.length).toBeGreaterThan(0);
    expect(series.every((p) => p.timestampMs >= cutoff)).toBe(true);
  });

  test('netApySeriesPercents converts bps samples to display percents', () => {
    expect(
      netApySeriesPercents([
        { timestampMs: 1, netApyBps: 450, sampleWindowSeconds: 3600 },
        { timestampMs: 2, netApyBps: 512, sampleWindowSeconds: 3600 },
      ]),
    ).toEqual([4.5, 5.12]);
  });
});

describe('dormant feed: 404 is UNAVAILABLE, not an error', () => {
  test('isYieldFeedUnavailableError only matches the 404 statusCode', () => {
    expect(YIELD_FEED_UNAVAILABLE_STATUS).toBe(404);
    expect(isYieldFeedUnavailableError(new FakeAPIError(404))).toBe(true);
    expect(isYieldFeedUnavailableError(new FakeAPIError(500, 'Internal Server Error'))).toBe(false);
    // statusCode 0 = the client's network-failure sentinel (api-client.ts:78).
    expect(isYieldFeedUnavailableError(new FakeAPIError(0, 'Network request failed'))).toBe(false);
    expect(isYieldFeedUnavailableError(new Error('boom'))).toBe(false);
    expect(isYieldFeedUnavailableError(undefined)).toBe(false);
    expect(isYieldFeedUnavailableError(null)).toBe(false);
    expect(isYieldFeedUnavailableError('404')).toBe(false);
  });

  test('loadYieldFeed folds a 404 into { status: "unavailable" }', async () => {
    const result = await loadYieldFeed(async () => {
      throw new FakeAPIError(404, 'Not Found');
    });
    expect(result).toEqual({ status: 'unavailable' });
  });

  test('loadYieldFeed passes real values through', async () => {
    expect(await loadYieldFeed(async () => ({ snapshots: [], lastSyncedId: '0' }))).toEqual({
      status: 'ok',
      value: { snapshots: [], lastSyncedId: '0' },
    });
  });

  test('loadYieldFeed rethrows REAL failures so they can retry/report', async () => {
    await expect(
      loadYieldFeed(async () => {
        throw new FakeAPIError(503, 'Service Unavailable');
      }),
    ).rejects.toThrow('503');
    await expect(
      loadYieldFeed(async () => {
        throw new FakeAPIError(0, 'Network request failed');
      }),
    ).rejects.toThrow('Network request failed');
  });
});

describe('formatSampleSpan (the chart must state what each sample annualizes)', () => {
  test('minutes / hours / days', () => {
    expect(formatSampleSpan(45 * 60)).toBe('45m');
    expect(formatSampleSpan(3600)).toBe('1h');
    expect(formatSampleSpan(6 * 3600)).toBe('6h');
    expect(formatSampleSpan(72 * 3600)).toBe('3d');
  });

  test('no span to describe → null (label omits the clause)', () => {
    expect(formatSampleSpan(null)).toBeNull();
    expect(formatSampleSpan(undefined)).toBeNull();
    expect(formatSampleSpan(0)).toBeNull();
    expect(formatSampleSpan(-10)).toBeNull();
    expect(formatSampleSpan(Number.NaN)).toBeNull();
  });
});

describe('window mapping', () => {
  test('chart periods map onto the endpoint windows the server accepts', () => {
    expect(APY_PERIOD_WINDOWS).toEqual({ '7D': '7d', '30D': '30d', '3M': '90d' });
    for (const window of Object.values(APY_PERIOD_WINDOWS)) {
      expect(APY_WINDOW_DAYS[window]).toBeGreaterThan(0);
    }
    expect(APY_WINDOW_DAYS).toEqual({ '7d': 7, '30d': 30, '90d': 90 });
  });
});

// ── drainYieldFeedPages (asp-v2@5f6b522 pagination) ───────────────────────
//
// The server pages both feeds (≤ YIELD_FEED_PAGE_SIZE rows, lastSyncedId =
// last row returned) and documents "poll until a short page". The drain must
// (a) reassemble the full feed across pages, (b) stay compatible with the
// pre-pagination protocol (one all-rows page, lastSyncedId = head), and
// (c) never loop forever on a cursor that stops advancing.

type FakePage = { rows: { id: string }[]; lastSyncedId: string };

/** Serves `total` rows in pages of `pageSize`, mimicking the server's cursor rules. */
function makePagedServer(total: number, pageSize: number) {
  const calls: (string | undefined)[] = [];
  const fetchPage = async (sinceId: string | undefined): Promise<FakePage> => {
    calls.push(sinceId);
    const from = sinceId === undefined ? 0 : Number(sinceId);
    const rows = Array.from(
      { length: Math.max(0, Math.min(pageSize, total - from)) },
      (_, i) => ({ id: String(from + i + 1) }),
    );
    // Server rule: last row returned; on an empty page hold at the caller's
    // cursor (or the head on an empty bootstrap).
    const lastSyncedId =
      rows.length > 0 ? rows[rows.length - 1].id : (sinceId ?? String(total));
    return { rows, lastSyncedId };
  };
  return { calls, fetchPage };
}

const drainOpts = {
  rowsOf: (page: FakePage) => page.rows,
  cursorOf: (page: FakePage) => page.lastSyncedId,
};

describe('drainYieldFeedPages', () => {
  test('reassembles a multi-page feed in order and lands the cursor on the last row', async () => {
    const server = makePagedServer(2500, 1000);
    const drained = await drainYieldFeedPages<FakePage, { id: string }>({
      fetchPage: server.fetchPage,
      ...drainOpts,
    });
    expect(drained.rows).toHaveLength(2500);
    expect(drained.rows[0].id).toBe('1');
    expect(drained.rows[2499].id).toBe('2500');
    expect(drained.lastSyncedId).toBe('2500');
    expect(drained.reason).toBe('complete');
    expect(drained.truncated).toBe(false);
    // SHORT-PAGE completion (review P2): the 500-row page proves caught-up, so
    // there is NO trailing empty probe — 3 calls, not 4. The probe was pure
    // cost, and a transient failure on it used to discard 2,500 good rows.
    expect(server.calls).toEqual([undefined, '1000', '2000']);
  });

  test('an EXACT page-size multiple needs one empty probe (the only ambiguous case)', () => {
    return (async () => {
      const server = makePagedServer(2000, 1000);
      const drained = await drainYieldFeedPages<FakePage, { id: string }>({
        fetchPage: server.fetchPage,
        ...drainOpts,
      });
      expect(drained.rows).toHaveLength(2000);
      expect(drained.reason).toBe('complete');
      expect(server.calls).toEqual([undefined, '1000', '2000']);
    })();
  });

  test('a server that SHRINKS its page size ends the drain early. Pinned tradeoff', async () => {
    // The short-page rule assumes the documented 1000-row cap. If the server
    // ever pages at 500, a full mid-feed page reads as short and the drain
    // stops. That is a protocol change the backend mirror tests must catch —
    // this test pins the client's (deliberate) behaviour under it.
    const calls: (string | undefined)[] = [];
    const fetchPage = async (sinceId: string | undefined): Promise<FakePage> => {
      calls.push(sinceId);
      if (sinceId === undefined) {
        return { rows: Array.from({ length: 1000 }, (_, i) => ({ id: String(i + 1) })), lastSyncedId: '1000' };
      }
      return { rows: Array.from({ length: 500 }, (_, i) => ({ id: String(1000 + i + 1) })), lastSyncedId: '1500' };
    };
    const drained = await drainYieldFeedPages<FakePage, { id: string }>({ fetchPage, ...drainOpts });
    expect(drained.rows).toHaveLength(1500);
    expect(drained.reason).toBe('complete');
    expect(calls).toEqual([undefined, '1000']);
  });

  test('a REGRESSING cursor (ping-pong server bug) is reported stalled, never looped', async () => {
    // Plain equality would miss '1000' -> '900' -> '1000' -> ... (kimi #6);
    // the numeric-monotonic guard catches the first regression.
    const fetchPage = async (sinceId: string | undefined): Promise<FakePage> => ({
      rows: Array.from({ length: 1000 }, (_, i) => ({ id: String(i + 1) })),
      lastSyncedId: sinceId === undefined ? '1000' : '900',
    });
    const drained = await drainYieldFeedPages<FakePage, { id: string }>({ fetchPage, ...drainOpts });
    expect(drained.reason).toBe('stalled');
    expect(drained.truncated).toBe(true);
  });

  test('resumes from a sinceId cursor (incremental poll)', async () => {
    const server = makePagedServer(1200, 1000);
    const drained = await drainYieldFeedPages<FakePage, { id: string }>({
      fetchPage: server.fetchPage,
      ...drainOpts,
      sinceId: '1100',
    });
    expect(drained.rows.map((r) => r.id)).toEqual(['1101', '1102', '1103', '1104', '1105', '1106', '1107', '1108', '1109', '1110'].concat(
      Array.from({ length: 90 }, (_, i) => String(1111 + i)),
    ));
    expect(drained.lastSyncedId).toBe('1200');
  });

  test('empty feed: one request, cursor holds at the server head', async () => {
    const server = makePagedServer(0, 1000);
    const drained = await drainYieldFeedPages<FakePage, { id: string }>({
      fetchPage: server.fetchPage,
      ...drainOpts,
    });
    expect(drained.rows).toHaveLength(0);
    expect(drained.lastSyncedId).toBe('0');
    expect(server.calls).toEqual([undefined]);
  });

  test('caught-up incremental poll: one request, cursor held', async () => {
    const server = makePagedServer(500, 1000);
    const drained = await drainYieldFeedPages<FakePage, { id: string }>({
      fetchPage: server.fetchPage,
      ...drainOpts,
      sinceId: '500',
    });
    expect(drained.rows).toHaveLength(0);
    expect(drained.lastSyncedId).toBe('500');
    expect(server.calls).toEqual(['500']);
  });

  test('pre-pagination server (one all-rows page, lastSyncedId = head) still drains cleanly', async () => {
    // Legacy protocol: everything in one response regardless of size.
    const calls: (string | undefined)[] = [];
    const fetchPage = async (sinceId: string | undefined): Promise<FakePage> => {
      calls.push(sinceId);
      if (sinceId === '1500') return { rows: [], lastSyncedId: '1500' };
      return {
        rows: Array.from({ length: 1500 }, (_, i) => ({ id: String(i + 1) })),
        lastSyncedId: '1500', // head, legacy semantics
      };
    };
    const drained = await drainYieldFeedPages<FakePage, { id: string }>({ fetchPage, ...drainOpts });
    expect(drained.rows).toHaveLength(1500);
    expect(drained.lastSyncedId).toBe('1500');
    // A page LARGER than the cap can only be the old unpaginated protocol —
    // complete after ONE call now (the empty probe it used to make was the
    // request whose transient failure could discard a whole good drain).
    expect(drained.reason).toBe('complete');
    expect(calls).toEqual([undefined]);
  });

  test('a non-advancing cursor on a non-empty page stops the drain (no infinite loop)', async () => {
    let callCount = 0;
    const fetchPage = async (sinceId: string | undefined): Promise<FakePage> => {
      callCount += 1;
      // Buggy server: always the same page, cursor pinned at the caller's value.
      return { rows: [{ id: '1' }], lastSyncedId: sinceId ?? '' };
    };
    const drained = await drainYieldFeedPages<FakePage, { id: string }>({ fetchPage, ...drainOpts });
    expect(callCount).toBe(1); // empty/equal cursor → stop immediately
    expect(drained.rows).toHaveLength(1);
  });

  test('maxPages caps the drain and reports truncation with a valid resume cursor', async () => {
    const server = makePagedServer(5000, 1000);
    const drained = await drainYieldFeedPages<FakePage, { id: string }>({
      fetchPage: server.fetchPage,
      ...drainOpts,
      maxPages: 2,
    });
    // The cap is a PARTIAL feed: reason must say so, because the hooks now
    // fail closed on anything but 'complete' (review P1 — a capped drain was
    // being published as a healthy feed of the OLDEST rows).
    expect(drained.reason).toBe('max-pages');
    expect(drained.rows).toHaveLength(2000);
    expect(drained.truncated).toBe(true);
    expect(drained.lastSyncedId).toBe('2000'); // resume point, no gap
    expect(server.calls).toEqual([undefined, '1000']);
  });

  test('errors propagate (the dormant-feed 404 folds via loadYieldFeed, not here)', async () => {
    const failing = () => Promise.reject(new FakeAPIError(404));
    await expect(
      drainYieldFeedPages<FakePage, { id: string }>({ fetchPage: failing, ...drainOpts }),
    ).rejects.toBeInstanceOf(FakeAPIError);
    const folded = await loadYieldFeed(() =>
      drainYieldFeedPages<FakePage, { id: string }>({ fetchPage: failing, ...drainOpts }),
    );
    expect(folded).toEqual({ status: 'unavailable' });
  });
});
