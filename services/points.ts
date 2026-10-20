/**
 * Points: the pure half. Maps the notes ppv2 already holds and the ASP's
 * published epochs onto the inputs of the SDK's `computePoints`, and its
 * answers onto what the points card prints.
 *
 * The SDK owns the formula; nothing here does arithmetic on points beyond
 * summing what it returns. Every parameter comes from a published epoch.
 *
 * Pure: no client, no clock. Bun tests import this directly.
 */
import { formatUnits } from 'viem';
import type { Hash, NotePointsStatus, PointsNoteInput, PointsSummary } from '@privacy-pools-v2/sdk';

export const POINTS_DECIMALS = 18;

export type PointsNoteLike = {
  commitment: string;
  value: string;
  tokenId: string;
  status: unknown;
  createdAtBlock?: string | null;
};

function toSeconds(value: string | null | undefined): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Notes as the SDK's input. A spent note whose spend time is not known is sent
 * with spentAt "unknown", which the SDK reports as `unknown-time` and counts
 * nothing for: sending null would count it as still held.
 */
export function toPointsNoteInputs(
  notes: readonly PointsNoteLike[],
  spentAt: (commitment: string) => number | null,
): PointsNoteInput[] {
  const inputs: PointsNoteInput[] = [];
  for (const note of notes) {
    const status = String(note.status).toUpperCase();
    let aspStatus: PointsNoteInput['aspStatus'];
    let spent = false;
    if (status === 'ACTIVE') aspStatus = 'approved';
    else if (status === 'PENDING') aspStatus = 'pending';
    else if (status === 'REJECTED') aspStatus = 'declined';
    else if (status === 'SPENT' || status === 'EXITED' || status === 'EXIT_PENDING') {
      aspStatus = 'approved';
      spent = true;
    } else continue;

    let value: bigint;
    try {
      value = BigInt(note.value);
    } catch {
      continue;
    }
    if (value <= 0n) continue;

    const spendTime = spent ? spentAt(note.commitment) : null;
    inputs.push({
      commitment: note.commitment as Hash,
      tokenId: note.tokenId,
      value,
      createdAt: toSeconds(note.createdAtBlock),
      spentAt: spent ? (spendTime === null ? 'unknown' : BigInt(spendTime)) : null,
      aspStatus,
    });
  }
  return inputs;
}

export type PointsRowStatus = 'accruing' | 'activating' | 'pending-review' | 'closed';

export type PointsRow = {
  key: string;
  chainId: number;
  tokenId: string;
  symbol: string;
  /** From published epochs, approved notes only: what a claim will pay. */
  claimable: bigint;
  /** From published epochs, notes still under ASP review: not claimable until approved. */
  pending: bigint;
  /** Since the last published epoch. */
  estimated: bigint;
  pointsPerDay: bigint;
  status: PointsRowStatus;
  /** Lowest and highest cohort multiplier among the row's live notes, in bps. */
  cohortBps: { min: number; max: number } | null;
  /** Earliest end of the cliff among the row's activating notes, unix seconds. */
  activatesAt: number | null;
};

export type PointsTotals = {
  claimable: bigint;
  pending: bigint;
  estimated: bigint;
  pointsPerDay: bigint;
  rows: PointsRow[];
  /** Notes left out because their creation or spend time is not known. */
  unknownTimeCount: number;
  /** Latest published epoch number across chains. */
  latestEpoch: bigint | null;
};

export type ChainPoints = {
  chainId: number;
  summary: PointsSummary;
  symbols: ReadonlyMap<string, string>;
  /**
   * Notes under ASP review. The SDK already keeps their published-epoch points
   * out of `claimable` (they are in `pending`); this marks their rows as under
   * review even before they have any published-epoch points.
   */
  pendingCommitments: ReadonlySet<string>;
  latestEpoch: bigint | null;
};

const STATUS_RANK: Record<PointsRowStatus, number> = {
  accruing: 0,
  activating: 1,
  'pending-review': 2,
  closed: 3,
};

function rowStatusOf(status: NotePointsStatus, pending: boolean): PointsRowStatus | null {
  if (status === 'accruing') return pending ? 'pending-review' : 'accruing';
  if (status === 'activating') return 'activating';
  if (status === 'closed') return 'closed';
  return null;
}

/** One row per chain + asset, plus totals across every chain. */
export function aggregatePoints(chains: readonly ChainPoints[]): PointsTotals {
  const rows = new Map<string, PointsRow>();
  let claimable = 0n;
  let pending = 0n;
  let estimated = 0n;
  let pointsPerDay = 0n;
  let unknownTimeCount = 0;
  let latestEpoch: bigint | null = null;

  for (const chain of chains) {
    claimable += chain.summary.claimable;
    pending += chain.summary.pending;
    estimated += chain.summary.estimated;
    pointsPerDay += chain.summary.pointsPerDay;
    if (chain.latestEpoch !== null && (latestEpoch === null || chain.latestEpoch > latestEpoch)) {
      latestEpoch = chain.latestEpoch;
    }
    for (const note of chain.summary.notes) {
      if (note.status === 'unknown-time') {
        unknownTimeCount += 1;
        continue;
      }
      const underReview = note.pending > 0n || chain.pendingCommitments.has(note.commitment);
      const status = rowStatusOf(note.status, underReview);
      if (status === null) continue;
      const tokenId = note.tokenId.toLowerCase();
      const key = `${chain.chainId}:${tokenId}`;
      const row = rows.get(key) ?? {
        key,
        chainId: chain.chainId,
        tokenId,
        symbol: chain.symbols.get(tokenId) ?? '',
        claimable: 0n,
        pending: 0n,
        estimated: 0n,
        pointsPerDay: 0n,
        status,
        cohortBps: null,
        activatesAt: null,
      };
      row.claimable += note.claimable;
      row.pending += note.pending;
      row.estimated += note.estimated;
      row.pointsPerDay += note.pointsPerDay;
      if (STATUS_RANK[status] < STATUS_RANK[row.status]) row.status = status;
      if (status !== 'closed') {
        row.cohortBps = row.cohortBps
          ? { min: Math.min(row.cohortBps.min, note.cohortBps), max: Math.max(row.cohortBps.max, note.cohortBps) }
          : { min: note.cohortBps, max: note.cohortBps };
      }
      if (note.status === 'activating' && note.activatesAt !== null) {
        const at = Number(note.activatesAt);
        row.activatesAt = row.activatesAt === null ? at : Math.min(row.activatesAt, at);
      }
      rows.set(key, row);
    }
  }

  const sorted = [...rows.values()]
    .filter((row) => row.status !== 'closed' || pointsTotal(row) > 0n)
    .sort((a, b) => {
      const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
      if (byStatus !== 0) return byStatus;
      const pa = pointsTotal(a);
      const pb = pointsTotal(b);
      return pb > pa ? 1 : pb < pa ? -1 : 0;
    });

  return { claimable, pending, estimated, pointsPerDay, rows: sorted, unknownTimeCount, latestEpoch };
}

/** Everything a row or the totals show as points: claimable + pending review + estimated. */
export function pointsTotal(points: { claimable: bigint; pending: bigint; estimated: bigint }): bigint {
  return points.claimable + points.pending + points.estimated;
}

export function formatPoints(value: bigint): string {
  if (value === 0n) return '0';
  const n = Number(formatUnits(value, POINTS_DECIMALS));
  if (n < 0.01) return '<0.01';
  return n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 2 });
}

function bpsMultiplier(bps: number): string {
  return `${Number((bps / 10_000).toFixed(2))}×`;
}

export function formatCohort(cohort: { min: number; max: number } | null): string {
  if (!cohort) return '—';
  return cohort.min === cohort.max ? bpsMultiplier(cohort.max) : `${bpsMultiplier(cohort.min)}–${bpsMultiplier(cohort.max)}`;
}

/** "3d 4h" style countdown; under an hour reads as "<1h". */
export function formatCountdown(seconds: number): string {
  if (seconds < 3600) return '<1h';
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}
