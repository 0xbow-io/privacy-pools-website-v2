/**
 * One chain head per chain, reused for one block time.
 *
 * The SDK asks for the head before every scan, the relayed-receipt wait asks on
 * every tick, and the app builds several RPC interactors per chain, each with
 * its own viem client and cache. So a relayed withdrawal on mainnet sent ~78
 * `eth_blockNumber` in three minutes, about 15 blocks' worth. A new head cannot
 * exist before the next block, so this answers every caller on a chain from one
 * value for one block time, and concurrent callers share one request.
 *
 * Only a cache. Nothing here decides WHEN anyone polls: callers keep their own
 * fixed cadence and simply get the remembered value inside the window.
 */

type Entry = {
  value?: bigint;
  at: number;
  inflight?: Promise<bigint>;
  /** A receipt's block seen while a refresh was in flight. */
  floor?: bigint;
};

export interface BlockNumberMemo {
  /** The head for `chainId`, from memory when younger than the chain's block time. */
  get(chainId: number, load: () => Promise<bigint>): Promise<bigint>;
  /**
   * A block this client has just seen exist (a receipt it waited for). Raises a
   * fresh remembered head to at least `blockNumber` so a scan right after the
   * wait reaches that block, including a refresh still in flight. Never
   * creates an entry and never lowers one.
   */
  observe(chainId: number, blockNumber: bigint): void;
}

export function createBlockNumberMemo(opts: {
  ttlMs: (chainId: number) => number;
  now?: () => number;
}): BlockNumberMemo {
  const now = opts.now ?? Date.now;
  const entries = new Map<number, Entry>();

  const fresh = (chainId: number, e: Entry | undefined): e is Entry & { value: bigint } =>
    e !== undefined && e.value !== undefined && now() - e.at < opts.ttlMs(chainId);

  return {
    get(chainId, load) {
      const e = entries.get(chainId);
      if (fresh(chainId, e)) return Promise.resolve(e.value);
      if (e?.inflight) return e.inflight;
      const entry: Entry = e ?? { at: 0 };
      entries.set(chainId, entry);
      const p = load().then(
        (fetched) => {
          // A head raised by observe() while this was in flight is newer
          // knowledge, whether the old value was still fresh or not; a lagging
          // node must not walk it back.
          let keep = fetched;
          if (fresh(chainId, entry) && entry.value > keep) keep = entry.value;
          if (entry.floor !== undefined && entry.floor > keep) keep = entry.floor;
          entry.value = keep;
          entry.at = now();
          entry.inflight = undefined;
          entry.floor = undefined;
          return keep;
        },
        (err) => {
          entry.inflight = undefined;
          entry.floor = undefined;
          throw err;
        },
      );
      entry.inflight = p;
      return p;
    },
    observe(chainId, blockNumber) {
      const e = entries.get(chainId);
      if (e?.inflight && (e.floor === undefined || blockNumber > e.floor)) e.floor = blockNumber;
      if (!fresh(chainId, e)) return;
      if (blockNumber > e.value) e.value = blockNumber;
    },
  };
}
