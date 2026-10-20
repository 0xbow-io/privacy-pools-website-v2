/**
 * The public activity feed, read in full per chain.
 *
 * `/global/public/events` serves at most 100 rows a page and reports the
 * chain's `total`. Reading only the first page (the old 50-row window per
 * chain) made the protocol-wide "All" list stop after ~50 rows a chain and its
 * "(N)" count report that window, not the protocol's activity: prod Ethereum
 * had 259 events and BNB Chain 176 while the list showed 77 rows.
 *
 * Every page is read on the feed's fixed cadence, never on a scroll or a tap,
 * so no request is timed by what the user is doing, and none names a note.
 */
import type { GlobalEvent, GlobalEventsResponse } from '@/services/api-types';

/** The ASP's per-page ceiling: a larger perPage is silently clamped to it. */
export const GLOBAL_EVENTS_PAGE_SIZE = 100;
/** Bounds one chain's read (5,000 rows) so a runaway total cannot loop. */
export const GLOBAL_EVENTS_MAX_PAGES = 50;

/** `complete`: every page up to the total (or the cap) was read, none failed. */
export type ChainEventsRead = { events: GlobalEvent[]; total: number; complete: boolean };

const uniqueIds = (events: readonly GlobalEvent[]) => new Set(events.map((e) => e.eventId)).size;

/** Newest first, one row per eventId (an offset window can repeat a row). */
function dedupe(events: readonly GlobalEvent[]): GlobalEvent[] {
  const seen = new Set<number>();
  return events.filter((e) => (seen.has(e.eventId) ? false : (seen.add(e.eventId), true)));
}

/**
 * Reads the chain's events. Page 1 (the query's page is 1-based, newest first)
 * is read on every tick. When the previous tick's read covered the chain and
 * page 1 overlaps it, the new rows are page 1 plus the rows already held, so a
 * tick costs one request per chain, as it did before. Deeper pages are read
 * only on the first load, or when more rows arrived than page 1 holds. A later
 * page that fails keeps what the previous read had instead of failing the
 * chain. The page size is the ASP's reported one, so a clamp cannot cut the
 * loop short, and the stop check counts unique eventIds. `total` is the ASP's
 * figure, so it stays right even when the cap truncates the rows.
 */
export async function readAllGlobalEventPages(
  fetchPage: (page: number, perPage: number) => Promise<GlobalEventsResponse>,
  {
    perPage = GLOBAL_EVENTS_PAGE_SIZE,
    maxPages = GLOBAL_EVENTS_MAX_PAGES,
    previous,
  }: { perPage?: number; maxPages?: number; previous?: ChainEventsRead } = {},
): Promise<ChainEventsRead> {
  const first = await fetchPage(1, perPage);
  const firstRows = first?.events ?? [];
  const reported = (res: GlobalEventsResponse | undefined) => (Number.isFinite(res?.total) ? (res as GlobalEventsResponse).total : 0);
  let total = reported(first);
  const pageSize = Number.isFinite(first?.perPage) && first.perPage > 0 ? Math.min(first.perPage, perPage) : perPage;

  // Only a complete earlier read can stand in for the deeper pages; a partial
  // one (a page failed) is read in full again, whatever its row count.
  if (previous?.complete && previous.events.length > 0) {
    const held = new Set(previous.events.map((e) => e.eventId));
    if (firstRows.some((e) => held.has(e.eventId)) || firstRows.length === 0) {
      const events = dedupe([...firstRows, ...previous.events]);
      return { events, total: Math.max(total, uniqueIds(events)), complete: true };
    }
  }

  let events = dedupe(firstRows);
  if (firstRows.length < pageSize || events.length >= total) return { events, total: Math.max(total, events.length), complete: true };
  let complete = true;
  for (let page = 2; page <= maxPages; page += 1) {
    let res: GlobalEventsResponse;
    try {
      res = await fetchPage(page, perPage);
    } catch {
      // Keep the pages already read (and anything held); the next tick sees
      // the read as partial and reads the deeper pages again.
      events = dedupe([...events, ...(previous?.events ?? [])]);
      complete = false;
      break;
    }
    const rows = res?.events ?? [];
    events = dedupe([...events, ...rows]);
    total = Math.max(total, reported(res));
    if (rows.length < pageSize || events.length >= total) break;
  }
  return { events, total: Math.max(total, events.length), complete };
}

/** Sum of the ASP totals for the given chains (all loaded chains when unset). */
export function totalForChains(
  totals: Readonly<Record<number, number>>,
  chainIds?: Iterable<number>,
): number {
  const ids = chainIds ? [...chainIds] : Object.keys(totals).map(Number);
  return ids.reduce((sum, cid) => sum + (totals[cid] ?? 0), 0);
}

/**
 * The "(N)" beside the Transactions heading. On the protocol-wide All tab,
 * unscoped by pool, it is the ASP's event total for the chains in view (the
 * Chain filter's, else every loaded chain's): the list holds grouped rows (a
 * swap's legs are one row), so its length is not the activity count. Anywhere
 * else, or before any total has loaded, it stays the rows in scope. So does
 * a Type, Status, Date or Amount filter (the ASP total cannot follow those),
 * a chain still loading its history, or a filtered chain with no total.
 */
export function activityHeaderCount(input: {
  scopeTab: 'all' | 'mine';
  scoped: boolean;
  rowCount: number;
  totals: Readonly<Record<number, number>> | undefined;
  chainFilter: ReadonlySet<number>;
  /** A Type, Status, Date or Amount filter is set. */
  otherFilters?: boolean;
  /** Some chain in view has not loaded its history yet. */
  incomplete?: boolean;
}): number {
  const { scopeTab, scoped, rowCount, totals, chainFilter, otherFilters, incomplete } = input;
  if (scopeTab !== 'all' || scoped || otherFilters || incomplete || !totals || Object.keys(totals).length === 0) return rowCount;
  if ([...chainFilter].some((cid) => totals[cid] === undefined)) return rowCount;
  return totalForChains(totals, chainFilter.size > 0 ? chainFilter : undefined);
}
