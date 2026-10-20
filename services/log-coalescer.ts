/**
 * One `eth_getLogs` per block window per contract, however many event types
 * are asked for.
 *
 * The SDK reads each pool event with its own call and a single-event ABI. The
 * bulk note index reads Deposited, Transacted and Ragequit together, then the
 * LeavesInserted tail past the ASP's coverage for its leaf check, and every one
 * of those tops up its own cache from the last block it saw to the head. So on
 * every new block the provider got four requests for the same one-block range
 * of the same contract, differing only in topic0 (seen in a relayed withdrawal
 * on mainnet, where the index is refreshed every few seconds).
 *
 * This merges them without changing what any caller receives:
 *
 * - Requests for the same contract and the same window that arrive in the same
 *   macrotask are sent as ONE call whose events are the union (viem turns
 *   several events into a single topic0 OR-list). Each caller gets back only the
 *   logs whose `eventName` it asked for, in chain order.
 * - A small window (a head top-up) also asks for every other event of that
 *   contract seen before, so the consumer that comes a moment later for the same
 *   block finds its logs already here. Large windows never widen past what was
 *   asked for together, so a lone historical scan of one event is not turned
 *   into a download of every event.
 * - A result is reused for one block time by any later request it covers (same
 *   contract, window inside it, events inside it), filtered by block and event.
 *
 * Failed calls are forgotten at once, so a retry or a shrunken window refetches.
 * Only whole windows of an address are shared: nothing here narrows a request,
 * filters by an indexed value, or times a request differently.
 */

export type EventFragment = { type?: string; name?: string };

export type CoalescedLog = { eventName?: string; blockNumber: unknown };

type Entry<L> = {
  start: bigint;
  end: bigint;
  names: ReadonlySet<string>;
  promise: Promise<L[]>;
  settledAt: number | null;
};

type Batch<L> = {
  events: Map<string, EventFragment>;
  load: (events: EventFragment[]) => Promise<L[]>;
  resolve: (logs: L[]) => void;
  reject: (err: unknown) => void;
  promise: Promise<L[]>;
};

export interface LogCoalescer<L extends CoalescedLog> {
  /**
   * Logs of `events` emitted by `address` in the inclusive window [start, end].
   * `load` issues the real call for whatever event list it is given.
   */
  fetch(
    address: string,
    events: readonly EventFragment[],
    start: bigint,
    end: bigint,
    load: (events: EventFragment[]) => Promise<L[]>,
  ): Promise<L[]>;
}

export interface LogCoalescerOptions {
  /** How long a settled result may answer a later request it covers. */
  ttlMs: number;
  /** Windows up to this many blocks also fetch every known event of the contract. */
  smallWindowBlocks?: bigint;
  now?: () => number;
  /** Defers a batch flush past the current macrotask. Injectable for tests. */
  schedule?: (fn: () => void) => void;
}

export const DEFAULT_SMALL_WINDOW_BLOCKS = 256n;

function blockOf(log: CoalescedLog): bigint | null {
  const b = log.blockNumber;
  if (typeof b === 'bigint') return b;
  if (typeof b === 'string' || typeof b === 'number') {
    try {
      return BigInt(b);
    } catch {
      return null;
    }
  }
  return null;
}

export function createLogCoalescer<L extends CoalescedLog>(opts: LogCoalescerOptions): LogCoalescer<L> {
  const now = opts.now ?? Date.now;
  const schedule = opts.schedule ?? ((fn: () => void) => { setTimeout(fn, 0); });
  const smallWindow = opts.smallWindowBlocks ?? DEFAULT_SMALL_WINDOW_BLOCKS;

  /** address -> event name -> fragment (and its serialized form, to catch a name reused with another shape). */
  const known = new Map<string, Map<string, { fragment: EventFragment; json: string }>>();
  const entries = new Map<string, Entry<L>[]>();
  const batches = new Map<string, Batch<L>>();

  const pick = (logs: L[], names: ReadonlySet<string>, start: bigint, end: bigint, exact: boolean): L[] => {
    const out: L[] = [];
    for (const log of logs) {
      if (log.eventName === undefined || !names.has(log.eventName)) continue;
      if (!exact) {
        const b = blockOf(log);
        if (b === null || b < start || b > end) continue;
      }
      out.push(log);
    }
    return out;
  };

  const prune = (list: Entry<L>[]): Entry<L>[] =>
    list.filter((e) => e.settledAt === null || now() - e.settledAt < opts.ttlMs);

  /** Registers the request's events; false when it cannot be merged safely. */
  const register = (address: string, events: readonly EventFragment[]): boolean => {
    if (events.length === 0) return false;
    let map = known.get(address);
    if (!map) {
      map = new Map();
      known.set(address, map);
    }
    const seen = new Set<string>();
    for (const e of events) {
      if (e?.type !== 'event' || typeof e.name !== 'string') return false;
      if (seen.has(e.name)) return false;
      seen.add(e.name);
      const json = JSON.stringify(e);
      const prev = map.get(e.name);
      // The same name with another signature: filtering by name would hand one
      // caller the other's logs. Leave this request alone.
      if (prev && prev.json !== json) return false;
    }
    for (const e of events) {
      if (!map.has(e.name!)) map.set(e.name!, { fragment: e, json: JSON.stringify(e) });
    }
    return true;
  };

  const flush = (address: string, key: string, start: bigint, end: bigint) => {
    const batch = batches.get(key);
    if (!batch) return;
    batches.delete(key);
    const union = new Map(batch.events);
    if (end - start + 1n <= smallWindow) {
      for (const [name, { fragment }] of known.get(address) ?? []) {
        if (!union.has(name)) union.set(name, fragment);
      }
    }
    const entry: Entry<L> = {
      start,
      end,
      names: new Set(union.keys()),
      promise: batch.promise,
      settledAt: null,
    };
    entries.set(address, [...prune(entries.get(address) ?? []), entry]);
    let call: Promise<L[]>;
    try {
      call = batch.load([...union.values()]);
    } catch (err) {
      call = Promise.reject(err);
    }
    call.then(
      (logs) => {
        entry.settledAt = now();
        batch.resolve(logs);
      },
      (err) => {
        // Forget a failure at once: the sweep's retry or narrower window refetches.
        const list = entries.get(address);
        if (list) entries.set(address, list.filter((e) => e !== entry));
        batch.reject(err);
      },
    );
  };

  return {
    fetch(rawAddress, events, start, end, load) {
      const address = rawAddress.toLowerCase();
      if (!register(address, events)) return load([...events]);
      const names = new Set(events.map((e) => e.name!));

      // A live result that covers this window and these events.
      const live = prune(entries.get(address) ?? []);
      entries.set(address, live);
      for (const e of live) {
        if (e.start > start || e.end < end) continue;
        let covers = true;
        for (const n of names) if (!e.names.has(n)) { covers = false; break; }
        if (!covers) continue;
        const exact = e.start === start && e.end === end;
        return e.promise.then((logs) => pick(logs, names, start, end, exact));
      }

      // Join (or open) the batch for exactly this window.
      const key = `${address}:${start}:${end}`;
      let batch = batches.get(key);
      if (!batch) {
        let resolve!: (logs: L[]) => void;
        let reject!: (err: unknown) => void;
        const promise = new Promise<L[]>((res, rej) => { resolve = res; reject = rej; });
        // Every waiter attaches its own handler; this one only keeps a failure
        // nobody else is waiting on from surfacing as unhandled.
        promise.catch(() => {});
        batch = { events: new Map(), load, resolve, reject, promise };
        batches.set(key, batch);
        schedule(() => flush(address, key, start, end));
      }
      for (const e of events) batch.events.set(e.name!, e);
      return batch.promise.then((logs) => pick(logs, names, start, end, true));
    },
  };
}
