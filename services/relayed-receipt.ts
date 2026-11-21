import type { Hash, Hex } from 'viem';

/**
 * Receipts for RELAYED transactions without naming the transaction to the RPC.
 *
 * The SDK's relayed paths (relayTransfer, relayWithdraw, relaySwap, batch)
 * hand the relayer's tx hash to `rpcInteractor.waitForTransactionReceipt`,
 * and a forwarded wait is viem polling `eth_getTransactionReceipt(hash)` every
 * few seconds until it mines. The provider then learns that THIS client is
 * waiting on THAT relayed transaction, at the exact moment it lands: the
 * relayer indirection is undone. docs/privacy-request-discipline.md forbids a
 * receipt or block read on a relayed hash for that reason, and the e2e privacy
 * gate reports each poll ("RPC saw a … in the body", five per transfer).
 *
 * Two pieces, both pure enough for bun to pin:
 *
 *  - Which hashes are relayed. The relayer interactor is the only source of
 *    them, so its `relay*` results are recorded here as they return, before the
 *    SDK gets to wait on them (`recordRelayedHashes`).
 *  - The receipt itself, from bulk data. Each new block's transaction-hash
 *    list (the block's own contents, not a lookup of our hash) says whether
 *    the transaction mined; the pool's and keystore's logs for that one block,
 *    fetched by address and range only, say whether it succeeded. A relayed
 *    spend, withdrawal, swap or registration always emits a log on one of
 *    those two contracts, so mined-without-logs is a revert, reported as a
 *    status-false receipt the way viem would. The result carries the raw logs,
 *    so the SDK's receipt-based nullifier check still works.
 *
 * A relayed transaction that never mines ends in a timeout, the same outcome
 * viem gives a transaction it never sees.
 */

const relayed = new Map<string, number>();

/** How long a recorded hash stays "relayed". A wait never lasts this long. */
export const RELAYED_HASH_TTL_MS = 60 * 60 * 1000;

const TX_HASH = /^0x[0-9a-f]{64}$/i;

const relayedListeners = new Set<(hash: string, method: string | null) => void>();

/** `method` is the relayer interactor method that returned the hash
 *  (relayTransfer, relayWithdrawal, relaySwap…), so a listener can keep to
 *  its own kind of operation. */
/** When each relayed hash's relay call was made (unix ms), when known. */
const relaySentAt = new Map<string, number>();

export function markRelayedTxHash(hash: string, now = Date.now(), method: string | null = null, sentAt: number | null = null): void {
  if (!TX_HASH.test(hash)) return;
  relayed.set(hash.toLowerCase(), now);
  if (sentAt !== null) relaySentAt.set(hash.toLowerCase(), sentAt);
  for (const listener of relayedListeners) {
    try { listener(hash, method); } catch { /* a listener must not break the relay */ }
  }
}

/**
 * Hear each relayed hash the moment the relayer returns it, before the SDK's
 * receipt wait starts (DEV-412). The SDK's relay* call only resolves after that
 * wait, so without this a flow shows "Submitting via relayer…" through the
 * whole confirmation and never learns the hash if the wait times out.
 * Returns the unsubscribe.
 */
export function onRelayedTxHash(listener: (hash: string, method: string | null) => void): () => void {
  relayedListeners.add(listener);
  return () => { relayedListeners.delete(listener); };
}

const relayCallListeners = new Set<(method: string, params: unknown) => void>();

/**
 * Hear the SDK call the relayer interactor's relay* method (DEV-494). The SDK's
 * relay* paths prove first and then hand the payload to the interactor, all
 * inside one promise, so without this a flow had no way to tell "proving" from
 * "waiting on the relayer" and showed "Generating proof" through a relayer that
 * took minutes. This is the CALL, not the HTTP send: the interactor still
 * validates the payload first, so a payload it refuses flips the label for the
 * instant before its error replaces it. Carries the method name and the
 * request the SDK built (in memory only: a flow reads its proof's public
 * signals, e.g. the association-set root, from it). Returns the unsubscribe.
 */
export function onRelayCalled(listener: (method: string, params: unknown) => void): () => void {
  relayCallListeners.add(listener);
  return () => { relayCallListeners.delete(listener); };
}

function announceRelayCall(method: string, params: unknown): void {
  for (const listener of relayCallListeners) {
    try { listener(method, params); } catch { /* a listener must not break the relay */ }
  }
}

export function isRelayedTxHash(hash: string, now = Date.now()): boolean {
  for (const [h, at] of relayed) {
    if (now - at > RELAYED_HASH_TTL_MS) { relayed.delete(h); relaySentAt.delete(h); }
  }
  return relayed.has(hash.toLowerCase());
}

/** When the relay call that returned `hash` was made (unix ms), or null. */
export function relayedTxSentAt(hash: string): number | null {
  return relaySentAt.get(hash.toLowerCase()) ?? null;
}

/** Test seam. */
export function forgetRelayedTxHashes(): void {
  relayed.clear();
  relaySentAt.clear();
}

function hashOf(result: unknown): string | null {
  if (typeof result === 'string') return TX_HASH.test(result) ? result : null;
  if (result && typeof result === 'object') {
    const r = result as { txHash?: unknown; hash?: unknown; transactionHash?: unknown };
    for (const v of [r.txHash, r.hash, r.transactionHash]) {
      if (typeof v === 'string' && TX_HASH.test(v)) return v;
    }
  }
  return null;
}

export type RelayHooks<C = unknown> = {
  /**
   * Runs before the request leaves; throwing refuses it (nothing is sent).
   * Its return value is threaded through to afterRelay/onRelayFailed for
   * this same call, so a fact read at submission time (e.g. the active
   * account) is not re-read — and possibly stale — once the relayer answers.
   */
  beforeRelay?: (method: string, params: unknown) => C;
  /** Runs once the relayer has returned a hash, before the caller sees it. */
  afterRelay?: (method: string, params: unknown, hash: string, context: C) => void;
  /** Runs when the request never got a hash back: rejected by beforeRelay, the relay call threw, or it returned no hash. */
  onRelayFailed?: (method: string, params: unknown, error: unknown, context: C) => void;
};

/**
 * Wrap a relayer interactor so every `relay*` / `submitRelayed*` method's transaction hash is
 * recorded as relayed before the caller sees it. Quotes and other methods pass
 * through untouched. `hooks` see the relay request (its proof's nullifiers)
 * on the way out and with the hash on the way back.
 */
export function recordRelayedHashes<T extends object, C = unknown>(inner: T, hooks: RelayHooks<C> = {}): T {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string' || !/^relay|Relayed/.test(prop)) return value;
      return function relayRecorded(this: unknown, ...args: unknown[]) {
        // Relay methods take (relayer, params).
        const params = args[1];
        let context: C = undefined as C;
        if (hooks.beforeRelay) {
          try {
            context = hooks.beforeRelay(prop, params);
          } catch (err) {
            try { hooks.onRelayFailed?.(prop, params, err, context); } catch { /* bookkeeping must not break the relay */ }
            return Promise.reject(err);
          }
        }
        const sentAt = Date.now();
        announceRelayCall(prop, params);
        const failed = (err: unknown) => {
          try { hooks.onRelayFailed?.(prop, params, err, context); } catch { /* bookkeeping must not break the relay */ }
        };
        const heard = (result: unknown) => {
          const h = hashOf(result);
          // Nothing to track without a hash: release what beforeRelay set up.
          if (!h) { failed(new Error('Relayer returned no transaction hash')); return; }
          try { hooks.afterRelay?.(prop, params, h, context); } catch { /* bookkeeping must not break the relay */ }
          markRelayedTxHash(h, Date.now(), prop, sentAt);
        };
        let out: unknown;
        try {
          out = (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (err) {
          failed(err);
          throw err;
        }
        if (out && typeof (out as Promise<unknown>).then === 'function') {
          return (out as Promise<unknown>).then(
            (result) => { heard(result); return result; },
            (err) => { failed(err); throw err; },
          );
        }
        heard(out);
        return out;
      };
    },
  });
}

/** The shape viem's `getLogs` returns for an unfiltered address query. */
export type RawLog = {
  address: Hex;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint | null;
  transactionHash: Hash | null;
  logIndex: number | null;
};

/** The SDK's TxReceipt, built here from bulk logs. */
export type RelayedReceipt = {
  txHash: Hash;
  status: boolean;
  blockNumber: Hex;
  logs: {
    address: Hex;
    topics: Hex[];
    data: Hex;
    blockNumber: Hex;
    transactionHash: Hash;
    logIndex: number;
  }[];
};

/**
 * The three bulk reads the wait is allowed: a block height, a block's
 * transaction-hash list, and an address+range log scan. None names the hash.
 */
export type RawLogClient = {
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint }): Promise<{ transactions: readonly (Hash | { hash: Hash })[]; timestamp?: bigint }>;
  getLogs(args: { address: readonly Hex[]; fromBlock: bigint; toBlock: bigint }): Promise<readonly RawLog[]>;
};

const toHex = (n: bigint): Hex => `0x${n.toString(16)}` as Hex;

/**
 * The receipt for `hash` if these logs contain it, else null. Status is
 * `true`: a transaction that emitted logs did not revert.
 */
export function receiptFromLogs(hash: Hash, logs: readonly RawLog[]): RelayedReceipt | null {
  const want = hash.toLowerCase();
  const mine = logs.filter(
    (l) => l.transactionHash && l.transactionHash.toLowerCase() === want && l.blockNumber !== null && l.logIndex !== null,
  );
  if (mine.length === 0) return null;
  const block = mine[0].blockNumber as bigint;
  return {
    txHash: hash,
    status: true,
    blockNumber: toHex(block),
    logs: mine.map((l) => ({
      address: l.address,
      topics: [...l.topics],
      data: l.data,
      blockNumber: toHex(l.blockNumber as bigint),
      transactionHash: hash,
      logIndex: l.logIndex as number,
    })),
  };
}

export class RelayedReceiptTimeout extends Error {
  constructor() {
    // No hash in the message: errors get logged.
    super('Relayed transaction was not observed in any block within the wait budget');
    this.name = 'RelayedReceiptTimeout';
  }
}

export type WaitForRelayedReceiptOptions = {
  /** Contract addresses whose logs the transaction must touch. */
  addresses: readonly Hex[];
  intervalMs?: number;
  budgetMs?: number;
  /** Blocks below the current head the first per-block walk starts at. */
  lookbackBlocks?: bigint;
  /** Blocks below the current head covered by ONE address+range log scan
   *  before the walk (DEV-412, default 900). A relayer can answer with the hash only after
   *  the transaction mined, a minute or more later; the walk's short lookback
   *  then never met the block and the whole budget ran out on a landed send. */
  logLookbackBlocks?: bigint;
  /** When the relay call was made (unix ms). With it, the first walk reaches
   *  back past `lookbackBlocks` to the block mined at that time, so a revert
   *  that mined before a slow relayer returned the hash is still seen. */
  sentAtMs?: number | null;
  /** Cap on the extra blocks that reach-back reads (default 128). */
  maxReachBackBlocks?: bigint;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * Wait for a relayed transaction without sending its hash anywhere: walk each
 * new block's transaction list until one contains it, then read that block's
 * logs for the given addresses. Resolves with a receipt whose logs are the
 * transaction's own (status false and no logs when it mined but touched
 * neither contract, i.e. reverted); throws RelayedReceiptTimeout when the
 * budget runs out.
 */
export async function waitForRelayedReceipt(
  hash: Hash,
  client: RawLogClient,
  opts: WaitForRelayedReceiptOptions,
): Promise<RelayedReceipt> {
  const intervalMs = opts.intervalMs ?? 4_000;
  const budgetMs = opts.budgetMs ?? 180_000;
  const lookback = opts.lookbackBlocks ?? 5n;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + budgetMs;
  const want = hash.toLowerCase();

  // Wide on purpose: blocks are 0.75s to 12s across the served chains, and the
  // incident this covers returned the hash minutes after mining. 900 stays
  // under the smallest configured getLogs range (1000).
  const logLookback = opts.logLookbackBlocks ?? 900n;
  let head = await client.getBlockNumber();
  // Already mined before the wait began? One bulk scan by address and range
  // answers it, whatever block it landed in. A failed scan is retried on each
  // tick until one completes; the walk runs meanwhile.
  //
  // A transaction that mined AND reverted more than `lookback` blocks before
  // the hash arrived has no log to find here and is below the walk. With
  // `sentAtMs` the walk reaches back to the block mined when the relay call
  // was made (below), so a slow relayer's revert is still seen: that is the
  // stale-root revert of 2026-11-21, which otherwise sat "not confirmed". The
  // reach-back is bounded by the relay's own duration and by
  // `maxReachBackBlocks`. Beyond it the wait still times out as "outcome
  // unknown", never as a success, and the notes stay unspent.
  const scanFrom = head > logLookback ? head - logLookback : 0n;
  const scanTo = head;
  let scanned = false;
  const scanOnce = async (): Promise<RelayedReceipt | null> => {
    try {
      const found = receiptFromLogs(hash, await client.getLogs({ address: opts.addresses, fromBlock: scanFrom, toBlock: scanTo }));
      scanned = true;
      return found;
    } catch {
      return null;
    }
  };
  const early = await scanOnce();
  if (early) return early;
  let next = head > lookback ? head - lookback : 0n;
  if (opts.sentAtMs != null && next > 0n) {
    // Step down from the walk's start while blocks were still mined after the
    // relay call, less 30 s and one block of slack for a device clock running
    // ahead of the chain. Each block read here is also checked for the hash,
    // the same bulk read the walk makes.
    const sentAtSec = BigInt(Math.floor((opts.sentAtMs - 30_000) / 1000));
    const floor = next > (opts.maxReachBackBlocks ?? 128n) ? next - (opts.maxReachBackBlocks ?? 128n) : 0n;
    try {
      for (let b = next - 1n; b >= floor; b -= 1n) {
        const block = await client.getBlock({ blockNumber: b });
        if (block.transactions.some((t) => (typeof t === 'string' ? t : t.hash).toLowerCase() === want)) {
          const logs = await client.getLogs({ address: opts.addresses, fromBlock: b, toBlock: b });
          return receiptFromLogs(hash, logs) ?? { txHash: hash, status: false, blockNumber: toHex(b), logs: [] };
        }
        if (block.timestamp === undefined || block.timestamp < sentAtSec) break;
        if (b === 0n) break;
      }
    } catch {
      // A failed read ends the reach-back early; the forward walk still runs.
    }
  }
  for (;;) {
    if (!scanned) {
      const found = await scanOnce();
      if (found) return found;
    }
    let b = next;
    try {
      for (; b <= head; b += 1n) {
        const block = await client.getBlock({ blockNumber: b });
        const mined = block.transactions.some((t) => (typeof t === 'string' ? t : t.hash).toLowerCase() === want);
        if (!mined) continue;
        const logs = await client.getLogs({ address: opts.addresses, fromBlock: b, toBlock: b });
        // Mined, but no log on the pool or keystore: the transaction reverted.
        return receiptFromLogs(hash, logs) ?? { txHash: hash, status: false, blockNumber: toHex(b), logs: [] };
      }
      next = head + 1n;
    } catch {
      // A failed block read used to abort the whole wait. Resume at the block
      // that failed on the next tick instead.
      next = b;
    }
    if (now() >= deadline) throw new RelayedReceiptTimeout();
    await sleep(intervalMs);
    try {
      head = await client.getBlockNumber();
    } catch {
      // keep the last head; the next tick retries
    }
  }
}
