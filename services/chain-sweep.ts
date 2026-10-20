import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Runs one step per chain with bounded concurrency — PURE module (no SDK /
 * react-native imports) so it can be unit-tested directly.
 *
 * syncAllChains used to walk the non-active chains one after another, so each
 * chain added to the build added its whole discovery time to the sweep (and
 * to the balance's "syncing" marker): 3 sibling chains became 6 on 2026-10-14.
 * The steps are independent (each chain its own session, its own bucket, its
 * own RPC and ASP host), so they run side by side, capped so one sweep never
 * opens more than `limit` discoveries at once.
 *
 * A step answering 'stale' means the identity changed underneath the sweep:
 * no further step is started and the result is 'stale' once the running ones
 * settle. Steps are expected to catch their own errors; one that throws is
 * counted as 'failed' and the others continue.
 */
// 'deferred': the chain's held event snapshot was not ready, so its scan waits
// for the feed grid instead of walking the chain from the deployment block.
export type ChainStepResult = 'synced' | 'skipped' | 'failed' | 'deferred' | 'stale';

export const DEFAULT_CHAIN_SWEEP_CONCURRENCY = 4;

/** Shared by grid passes and foreground sweeps, including queued old sessions. */
export function createChainLimiter() {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async (step: () => Promise<ChainStepResult>): Promise<ChainStepResult> => {
    if (running >= DEFAULT_CHAIN_SWEEP_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await step();
    } finally {
      const next = waiting.shift();
      if (next) next(); // Transfer this slot to the oldest waiter.
      else running--;
    }
  };
}

export async function sweepChains(
  chainIds: readonly number[],
  step: (chainId: number) => Promise<ChainStepResult>,
  limit: number = DEFAULT_CHAIN_SWEEP_CONCURRENCY,
  /** Called once per chain that finished, failed or was skipped (not on stale). */
  onChainDone?: (chainId: number) => void,
): Promise<'done' | 'stale'> {
  let next = 0;
  let stale = false;
  const worker = async () => {
    while (!stale && next < chainIds.length) {
      const cid = chainIds[next++];
      let result: ChainStepResult;
      try {
        result = await step(cid);
      } catch {
        result = 'failed';
      }
      if (result === 'stale') stale = true;
      else onChainDone?.(cid);
    }
  };
  const width = Math.max(1, Math.min(limit, chainIds.length));
  await Promise.all(Array.from({ length: width }, worker));
  return stale ? 'stale' : 'done';
}

/**
 * The balance's sync marker text. Counts down as each chain of the sweep
 * finishes (a failed chain counts as done); at 0 the plain word stays only for
 * whatever non-sweep phase is still running, and the marker goes with it.
 */
export function syncingLabel(chainsLeft: number): string {
  if (chainsLeft <= 0) return 'Syncing';
  return `Syncing (${chainsLeft} ${chainsLeft === 1 ? 'chain' : 'chains'} left)`;
}

/** The part of the feed grid this module needs (services/public-feed-scheduler.ts). */
export type FeedReader = {
  read: (key: string) => { status: string; data?: unknown };
  subscribe: (key: string, listener: () => void) => () => void;
};

/** True once the grid holds a copy for this feed, even if its latest refresh failed. */
export function feedHasData(state: { status: string; data?: unknown }): boolean {
  return state.status === 'ready' || (state.status === 'error' && state.data !== undefined);
}

/**
 * Waits for the grid to hold a copy of `key`, at most `timeoutMs`. Gates note
 * discovery on DATA readiness: without the held snapshot the SDK falls back to
 * walking the chain from the deployment block (Citrea: 1000-block windows, 800+
 * eth_getLogs, minutes; measured on prod 2026-10-15 while the ASP answered 429).
 * Sends nothing itself.
 */
export function waitForFeed(feeds: FeedReader, key: string, timeoutMs: number): Promise<boolean> {
  if (feedHasData(feeds.read(key))) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(ok);
    };
    const unsubscribe = feeds.subscribe(key, () => { if (feedHasData(feeds.read(key))) finish(true); });
    const timer = setTimeout(() => finish(feedHasData(feeds.read(key))), timeoutMs);
  });
}

/** Preserve the deepest deferred range until that session has scanned it. */
export function earliestScanOptions(a?: { fromBlock?: string }, b?: { fromBlock?: string }): { fromBlock?: string } | undefined {
  if (!a?.fromBlock) return b;
  if (!b?.fromBlock) return a;
  return BigInt(a.fromBlock) <= BigInt(b.fromBlock) ? a : b;
}

/**
 * Hash the actual pool-wide rows, excluding the advancing advertised head.
 * Counts and newest blocks miss corrections and same-height replacements.
 * Hash each section separately so we retain only a small digest per chain.
 */
export function snapshotActivityFingerprint(held: unknown, decisions?: unknown): string | null {
  if (!held || typeof held !== 'object') return null;
  const h = held as Record<string, unknown>;
  const digest = sha256.create();
  for (const section of ['notes', 'deposits', 'transacts', 'ragequits']) {
    const rows = h[section];
    if (!Array.isArray(rows)) return null;
    digest.update(utf8ToBytes(section));
    digest.update(utf8ToBytes(JSON.stringify(rows)));
  }
  // Approval and rejection changes can change note status without a chain event.
  if (decisions !== undefined) digest.update(utf8ToBytes(JSON.stringify(decisions)));
  return bytesToHex(digest.digest());
}

/** A held-back SDK cursor means unresolved notes or statuses still need retry. */
export function snapshotScanComplete(held: unknown, cursor: unknown): boolean {
  try {
    const boundary = (held as { snapshotBlockNumber?: string } | null)?.snapshotBlockNumber;
    return boundary != null && BigInt(boundary) > 0n && typeof cursor === 'string'
      && BigInt(cursor) >= BigInt(boundary);
  } catch {
    return false;
  }
}
