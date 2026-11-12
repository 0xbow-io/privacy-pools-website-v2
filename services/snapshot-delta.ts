/**
 * Topping up an event-snapshot payload in place, instead of downloading the
 * pool's whole history again on every refresh.
 *
 * PURE module (no SDK / react-native imports), bun-testable.
 *
 * A page load downloads the snapshot once. Each later refresh in the same page
 * asks only for `sinceBlock` onward and replaces the payload's tail with it, so
 * a live tab pays a few KB per refresh, not the whole pool. Nothing is kept
 * across page loads: the next load downloads it whole again.
 *
 * WHY THE DELTA STARTS WELL BEHIND THE LAST COVERED BLOCK. The ASP can index a
 * row after it already advertised a later block (2026-08-27: rows lagged the
 * advertised head by six minutes). A refresh that started at the advertised
 * block would never see such a row for the rest of the page's life, and some
 * callers turn "not in the snapshot" into "never landed on-chain". So every
 * delta re-reads at least one grid step and at least a day of blocks, and the
 * rows it returns REPLACE everything above its start: late rows appear, and a
 * row the ASP no longer serves disappears.
 *
 * PRIVACY. `sinceBlock` is snapped down onto the shared scan grid
 * (services/log-scan-alignment.ts), the value the leaf fast path in
 * services/sdk-setup.ts already sends, so it names a region of history many
 * clients share rather than this client's own watermark.
 */
import { snapshotCursor } from '@/services/asp-event-snapshot';
import { alignLogScanStart, LOG_SCAN_ALIGNMENT_BLOCKS } from '@/services/log-scan-alignment';

/** How far behind the last covered block every delta starts, at least. */
export const SNAPSHOT_DELTA_OVERLAP_MS = 24 * 60 * 60_000;

/**
 * The exclusive `sinceBlock` (the server returns rows `> sinceBlock`) for a
 * delta on top of a payload indexed through `coveredTo`.
 */
export function snapshotDeltaSince(coveredTo: bigint, deploymentBlock: bigint, blockTimeMs: number): bigint {
  const dayOfBlocks = BigInt(Math.ceil(SNAPSHOT_DELTA_OVERLAP_MS / Math.max(1, blockTimeMs)));
  const overlap = dayOfBlocks > LOG_SCAN_ALIGNMENT_BLOCKS ? dayOfBlocks : LOG_SCAN_ALIGNMENT_BLOCKS;
  const start = coveredTo + 1n > overlap ? coveredTo + 1n - overlap : 0n;
  const aligned = alignLogScanStart(start, deploymentBlock);
  return aligned > 0n ? aligned - 1n : 0n;
}

type Row = { blockNumber?: unknown; txHash?: unknown; logIndex?: unknown };

function rowBlock(row: Row): bigint | null {
  const value = row?.blockNumber;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function rowKey(row: Row): string | null {
  if (typeof row?.txHash !== 'string' || (typeof row.logIndex !== 'number' && typeof row.logIndex !== 'string')) return null;
  return `${row.txHash.toLowerCase()}:${String(row.logIndex)}`;
}

/**
 * `base` with every section's rows above `since` replaced by `delta`'s, and
 * `delta`'s envelope (its block, its timestamp). Null when the two cannot be
 * joined safely, and the caller downloads the payload whole instead: a
 * different chain, a section missing from either side, or a base row whose
 * block is unreadable, which this join could neither place nor keep without
 * risking a duplicate.
 */
export function mergeSnapshotDelta<T extends Record<string, unknown>>(
  base: T,
  delta: T,
  since: bigint,
  sections: readonly string[],
): T | null {
  if (String(base?.chainId ?? '') !== String(delta?.chainId ?? '')) return null;
  const merged: Record<string, unknown> = { ...delta };
  for (const section of sections) {
    const baseRows = base[section];
    const deltaRows = delta[section];
    if (!Array.isArray(baseRows) || !Array.isArray(deltaRows)) return null;
    const replaced = new Set<string>();
    for (const row of deltaRows as Row[]) {
      const key = rowKey(row);
      if (key) replaced.add(key);
    }
    const kept: unknown[] = [];
    for (const row of baseRows as Row[]) {
      const block = rowBlock(row);
      if (block === null) return null;
      if (block > since) continue;
      const key = rowKey(row);
      if (key && replaced.has(key)) continue;
      kept.push(row);
    }
    merged[section] = [...kept, ...deltaRows];
  }
  return merged as T;
}

/** A runaway guard: the ASP pages at 5,000 rows, so 50 pages is 250,000 rows of one section. */
export const MAX_SNAPSHOT_PAGES = 50;

/**
 * Joins the pages after `first` while the ASP says `hasMore` (asp-v2#205).
 * Each page starts at the previous page's `snapshotBlockNumber`, which the ASP
 * chose from its data and the request alone, so every client asks for the same
 * pages. A page that cannot be joined, or does not move forward, ends the loop:
 * the payload then claims only the blocks it holds, and the next refresh tops
 * it up.
 */
export async function followSnapshotPages<T>(
  first: T,
  sections: readonly string[],
  fetchPage: (since: bigint) => Promise<T>,
): Promise<T> {
  let held = first;
  for (let page = 1; (held as { hasMore?: unknown })?.hasMore === true && page < MAX_SNAPSHOT_PAGES; page++) {
    const since = snapshotCursor(held, sections);
    if (since === null) break;
    const merged = mergeSnapshotDelta(
      held as Record<string, unknown>,
      (await fetchPage(since)) as Record<string, unknown>,
      since,
      sections,
    );
    const reached = merged ? snapshotCursor(merged, sections) : null;
    if (!merged || reached === null || reached <= since) break;
    held = merged as T;
  }
  return held;
}
