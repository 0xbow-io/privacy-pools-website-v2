import { useMemo } from 'react';
import { useNotes } from '@/hooks/use-notes';
import { NoteStatus, type Note } from '@/services/sdk-types';
import { getTokenMetadata, isStablecoin } from '@/config/tokens';
import { usePools } from '@/components/pools-provider';

export type TimePeriod = '7D' | '30D' | '3M' | 'Max';
export type HistoryPoint = { timestamp: number; balance: number };

const PERIOD_SECONDS: Record<TimePeriod, number> = {
  '7D': 7 * 86400,
  '30D': 30 * 86400,
  '3M': 90 * 86400,
  Max: Number.POSITIVE_INFINITY,
};

// Reject obviously-not-a-unix-timestamp values. Some callers of the SDK
// persist `createdAtBlock` / `spentAtBlock` as raw block numbers
// (e.g. 9023843) instead of chain timestamps, which would otherwise be
// interpreted as seconds-since-epoch and land in 1970. Anything before
// 2001 (~1e9) is treated as invalid so the fallback paths can kick in.
const MIN_PLAUSIBLE_UNIX_SECONDS = 1_000_000_000;

function toUnix(hexOrDec: string | null | undefined): number {
  if (!hexOrDec) return 0;
  try {
    const n = Number(BigInt(hexOrDec));
    if (!Number.isFinite(n) || n < MIN_PLAUSIBLE_UNIX_SECONDS) return 0;
    return n;
  } catch {
    return 0;
  }
}

function toTokenAmount(valueHex: string, decimals: number): number {
  try {
    const wei = BigInt(valueHex);
    if (wei === 0n) return 0;
    const divisor = 10n ** BigInt(decimals);
    const whole = Number(wei / divisor);
    const frac = Number(wei % divisor) / Number(divisor);
    return whole + frac;
  } catch {
    return 0;
  }
}

function resolveSpentUnix(note: Note, now: number): number {
  const explicitSpent = toUnix(note.spentAtBlock ?? undefined);
  if (explicitSpent > 0) return explicitSpent;

  const status = String(note.status);
  if (
    status === NoteStatus.SPENT ||
    status === NoteStatus.EXITED ||
    status === 'SPENT' ||
    status === 'EXITED' ||
    status === 'spent' ||
    status === 'exited'
  ) {
    return now;
  }

  return 0;
}

function collapseHistoryPoints(points: HistoryPoint[]): HistoryPoint[] {
  if (points.length <= 1) return points;

  const collapsed: HistoryPoint[] = [];
  for (const point of points) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.timestamp === point.timestamp) {
      last.balance = point.balance;
      continue;
    }
    collapsed.push({ ...point });
  }
  return collapsed;
}

/**
 * Build a step-function balance history for the given pool (tokenId) from
 * the user's local NoteManager. No network. Server never sees which
 * commitments a wallet owns, by design.
 *
 * Algorithm:
 *   every ACTIVE / SPENT / EXITED note contributes +value from its
 *   createdAtBlock until its spentAtBlock. If a note is already SPENT /
 *   EXITED but the app never persisted spentAtBlock, we conservatively end it
 *   at "now" so the chart tail matches the actual current balance. PENDING
 *   and 0-value change notes are skipped. Sort, running sum, filter by
 *   window.
 */
export function usePortfolioHistory(options: {
  tokenAddress: string;
  decimals: number;
  period: TimePeriod;
}): HistoryPoint[] {
  const { tokenAddress, decimals, period } = options;
  const { notes } = useNotes();

  return useMemo(() => {
    if (!tokenAddress) return [];
    const targetAddr = tokenAddress.toLowerCase();
    const now = Math.floor(Date.now() / 1000);

    // Compute the authoritative current ACTIVE balance the same way
    // portfolio-provider does — regardless of whether individual notes had
    // usable timestamps. This pins the chart's right edge to the Net Value
    // headline figure.
    let currentActive = 0;
    for (const n of notes as Note[]) {
      if (String(n.tokenId || '').toLowerCase() !== targetAddr) continue;
      const s = String(n.status);
      if (s !== NoteStatus.ACTIVE && s !== 'ACTIVE' && s !== 'active') continue;
      currentActive += toTokenAmount(n.value, decimals);
    }

    // Extract +delta / -delta events in chain timestamps. Skip the -delta
    // when we never saw a matching +delta (note created with a placeholder
    // 0 timestamp), otherwise the running total dips negative and the area
    // chart draws below baseline.
    const events: { t: number; delta: number }[] = [];
    for (const n of notes as Note[]) {
      if (String(n.tokenId || '').toLowerCase() !== targetAddr) continue;
      if (n.status === NoteStatus.PENDING) continue;
      if (n.status === NoteStatus.INACTIVE) continue;
      const value = toTokenAmount(n.value, decimals);
      if (value === 0) continue;
      const created = toUnix(n.createdAtBlock);
      if (!created) continue;
      events.push({ t: created, delta: value });
      const spent = resolveSpentUnix(n, now);
      if (spent && spent >= created) events.push({ t: spent, delta: -value });
    }

    if (events.length === 0) {
      // No timestamped history but we may still have ACTIVE notes (bad block
      // metadata). Render a single-point chart pinned at the current balance.
      if (currentActive <= 0) return [];
      return [{ timestamp: now, balance: currentActive }];
    }
    events.sort((a, b) => a.t - b.t);

    // Window selection.
    const cutoff = period === 'Max' ? 0 : now - PERIOD_SECONDS[period];

    // Walk once, emitting a point per event. Clamp at 0 — ordering quirks
    // in the snapshot can briefly push the running total negative before
    // the matching deposit arrives; clamping keeps the chart truthful.
    let running = 0;
    let startingBalance = 0;
    const inWindow: HistoryPoint[] = [];
    for (const e of events) {
      running = Math.max(0, running + e.delta);
      if (e.t < cutoff) {
        startingBalance = running;
        continue;
      }
      inWindow.push({ timestamp: e.t, balance: running });
    }

    const points: HistoryPoint[] = [];
    if (period !== 'Max') {
      points.push({ timestamp: cutoff, balance: startingBalance });
    } else if (events.length > 0) {
      // Anchor the left edge to just before the first event so the line
      // starts at zero and steps up on the first deposit.
      points.push({ timestamp: Math.max(0, events[0].t - 1), balance: 0 });
    }
    points.push(...inWindow);
    // Right edge = now, but pin it to the actual current ACTIVE balance so
    // the chart always agrees with the Net Value headline even when some
    // notes had unusable createdAtBlock/spentAtBlock metadata.
    points.push({ timestamp: now, balance: currentActive });
    return collapseHistoryPoints(points);
  }, [notes, tokenAddress, decimals, period]);
}

/**
 * Aggregate USD history across every asset the user holds. Each note's +/- delta
 * is converted to USD using the current priceMap (stablecoins default to $1).
 * Good enough for a portfolio overview; not intended as historical pricing.
 */
export function usePortfolioUsdHistory(options: {
  period: TimePeriod;
  chainId: number;
}): HistoryPoint[] {
  const { period, chainId } = options;
  const { notes } = useNotes();
  const { data } = usePools();

  return useMemo(() => {
    const priceMap = data.priceMap ?? {};
    const now = Math.floor(Date.now() / 1000);

    // Authoritative current USD balance — mirrors portfolio-provider. Pins
    // the chart's right edge regardless of historical timestamp quality.
    let currentActiveUsd = 0;
    for (const n of notes as Note[]) {
      const s = String(n.status);
      if (s !== NoteStatus.ACTIVE && s !== 'ACTIVE' && s !== 'active') continue;
      const meta = getTokenMetadata(String(n.tokenId || ''), chainId);
      const amount = toTokenAmount(n.value, meta.decimals);
      if (amount === 0) continue;
      const stableFallback = isStablecoin(meta.symbol) ? 1 : 0;
      const price = priceMap[meta.address.toLowerCase()] || priceMap[meta.symbol] || stableFallback;
      if (price <= 0) continue;
      currentActiveUsd += amount * price;
    }

    const events: { t: number; delta: number }[] = [];
    for (const n of notes as Note[]) {
      if (n.status === NoteStatus.PENDING) continue;
      if (n.status === NoteStatus.INACTIVE) continue;
      const meta = getTokenMetadata(String(n.tokenId || ''), chainId);
      const amount = toTokenAmount(n.value, meta.decimals);
      if (amount === 0) continue;
      const stableFallback = isStablecoin(meta.symbol) ? 1 : 0;
      const price = priceMap[meta.address.toLowerCase()] || priceMap[meta.symbol] || stableFallback;
      if (price <= 0) continue;
      const usd = amount * price;
      const created = toUnix(n.createdAtBlock);
      if (!created) continue;
      events.push({ t: created, delta: usd });
      const spent = resolveSpentUnix(n, now);
      if (spent && spent >= created) events.push({ t: spent, delta: -usd });
    }

    if (events.length === 0) {
      if (currentActiveUsd <= 0) return [];
      return [{ timestamp: now, balance: currentActiveUsd }];
    }
    events.sort((a, b) => a.t - b.t);

    const cutoff = period === 'Max' ? 0 : now - PERIOD_SECONDS[period];
    let running = 0;
    let startingBalance = 0;
    const inWindow: HistoryPoint[] = [];
    for (const e of events) {
      running = Math.max(0, running + e.delta);
      if (e.t < cutoff) {
        startingBalance = running;
        continue;
      }
      inWindow.push({ timestamp: e.t, balance: running });
    }

    const points: HistoryPoint[] = [];
    if (period !== 'Max') {
      points.push({ timestamp: cutoff, balance: startingBalance });
    } else if (events.length > 0) {
      points.push({ timestamp: Math.max(0, events[0].t - 1), balance: 0 });
    }
    points.push(...inWindow);
    // Pin the right edge to the authoritative current balance so the chart
    // agrees with the Net Value headline regardless of historical gaps.
    points.push({ timestamp: now, balance: currentActiveUsd });
    return collapseHistoryPoints(points);
  }, [notes, data.priceMap, period, chainId]);
}
