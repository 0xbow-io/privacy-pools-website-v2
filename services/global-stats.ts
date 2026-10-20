// Pure selectors for the asp-v2 PR #92 (issue #91) additions to the public
// statistics payload: median deposit size + in-pool transfers count on
// TimeBasedStats. No React imports — unit-tested in
// services/__tests__/global-stats.test.ts.
//
// GRACEFUL-ABSENCE CONTRACT: the deployed API does not send these fields yet
// (verified live 2026-07-28). Every selector returns null when its field is
// absent, unparsable, or not trustworthy, and consumers OMIT the figure on
// null — never a $0, a dash, or a fabricated stand-in (config/yield.ts's
// omit-the-unknown policy). The moment the deployed API starts sending the
// fields, the same selectors return real values on the normal fetch cadence —
// no client change, no flag.
//
// PARSING IS STRICT BY DESIGN (review findings, codex + kimi 2026-07-28):
// parseFloat-style prefix parsing turned junk into authoritative-looking
// figures — "1,800.00" became $1, "12junk" became $12, "-5" rendered "$-5".
// A wrong number is worse than an omission, so anything that is not a complete
// non-negative decimal string is rejected outright.

import type { TimeBasedStats } from '@/services/api-types';
import { formatUsd } from '@/services/format-fiat';

/** A COMPLETE non-negative decimal string ("12", "12.5", "0.00") — else null. */
function strictNonNegativeDecimal(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * `medianDepositSizeUsd` as a finite non-negative number, or null when the
 * server predates PR #92 (field absent), sent junk, or the median comes from
 * an EMPTY population: the backend encodes "no deposits in this window" as
 * "0.00" rather than omitting the field, and a real-looking "$0 median" tile
 * for an empty 24h window is misinformation. A zero median WITH deposits in
 * the window is kept — that would be a genuine (dust) figure.
 */
export function medianDepositUsd(stats: Partial<TimeBasedStats> | null | undefined): number | null {
  const n = strictNonNegativeDecimal(stats?.medianDepositSizeUsd);
  if (n === null) return null;
  if (n === 0 && !((stats?.totalDepositsCount ?? 0) > 0)) return null;
  return n;
}

/** medianDepositUsd() pre-formatted for display; null still means OMIT. */
export function medianDepositUsdText(stats: Partial<TimeBasedStats> | null | undefined): string | null {
  const usd = medianDepositUsd(stats);
  return usd === null ? null : formatUsd(usd);
}

/**
 * `totalTransfersCount` (in-pool transfers) or null when the server predates
 * PR #92 or sent something that is not a non-negative safe integer. Mirrors
 * the backend schema exactly (a bare int) — no rounding, no string coercion:
 * a fractional or string-typed count is a server bug and must fall back, not
 * be laundered into a plausible figure.
 */
export function serverTransfersCount(stats: Partial<TimeBasedStats> | null | undefined): number | null {
  const raw = stats?.totalTransfersCount;
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) return null;
  return raw;
}

/**
 * The transfers count to display: the server's figure when present and sane,
 * else the client-computed fallback.
 *
 * SCOPE (review P1): pass PER-ASSET stats here on a pool page — never the
 * global aggregate. The global payload's count spans every pool, so wiring it
 * into a pool card silently flips the row from pool-local to protocol-wide
 * the day the API deploys, with no label change.
 */
export function resolveTransfersCount(
  stats: Partial<TimeBasedStats> | null | undefined,
  clientCount: number,
): number {
  return serverTransfersCount(stats) ?? clientCount;
}
