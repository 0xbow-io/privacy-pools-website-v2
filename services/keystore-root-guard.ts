/**
 * Keystore-root health check and chain rebuild. PURE module (no SDK, react
 * native or network imports; every read is injected), so bun tests drive it.
 *
 * THE INCIDENT (2026-11-09). The ASP's keystore leaf list was one registration
 * behind the chain (leaf 362 missing) while its snapshot advertised the chain
 * head. The client builds the keystore tree from that list and trusts the
 * advertised head, so every withdrawal and every exit proved against a keystore
 * root the vault no longer accepted (PoolVault_UnknownKeystoreRoot: the vault
 * takes the current root, or a superseded one for 1200 s). An exit that needs a
 * correct ASP is not an exit.
 *
 * THE CHECK. Compare the root the held leaves imply with the chain's
 * Keystore.currentRoot(). Both sides are public and nothing in the request is
 * derived from a user's notes. It runs ONLY on the public feed grid
 * (services/public-feeds.ts), never from a user action: a read timed by the
 * user's click would announce the click.
 *
 * THE REPAIR. When the roots disagree, rebuild the leaf set from the chain's
 * LeafInserted / LeafUpdated events and hold it (the correction store). A
 * rebuilt set is accepted only when BOTH hold:
 *   1. the leaves are contiguous (no missing index), and
 *   2. the root after the last event (each event carries the root it produced)
 *      AND the Merkle root computed from the leaves both equal currentRoot.
 * A lossy eth_getLogs answer (a dropped event) fails one of these and is never
 * accepted. Repair is tiered: first only the tail above the newest held event
 * (cheap, one window on a quiet keystore), then, on a cooldown, the whole
 * history from the keystore's first block.
 *
 * Whatever is held is read by services/sdk-setup.ts (the leaf source every
 * proof uses) and reconciled into the SDK's keystore interactor, so the
 * withdraw and the exit prove against a root the vault accepts without asking
 * the ASP for anything.
 */

import { alignLogScanStart } from '@/services/log-scan-alignment';
import { classifyLimitError, isRateLimitError, parseBlockRangeCap } from '@/services/rpc-log-chunking';

export type KeystoreEvent = {
  kind: 'inserted' | 'updated';
  leafIndex: bigint;
  leaf: bigint;
  /** The keystore root right after this event. */
  root: bigint;
  blockNumber: bigint;
  /** Order within the block. For ASP rows, the row's position. */
  logIndex: number;
};

/** The ASP row shape (services/api-types.ts SnapshotLeaf), the fields used. */
export type KeystoreLeafRowLike = {
  leaf: string;
  leafIndex: string;
  root: string;
  blockNumber: string;
  eventType: string;
};

/** The SDK's leaf encoding (bigintToHex): 32 bytes, 0x-prefixed. */
export function leafHex(value: bigint): `0x${string}` {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

/** Rows of an ASP snapshot as events. Null when any row is malformed. */
export function eventsFromRows(rows: readonly KeystoreLeafRowLike[] | null | undefined): KeystoreEvent[] | null {
  if (!Array.isArray(rows)) return null;
  const out: KeystoreEvent[] = [];
  try {
    rows.forEach((row, position) => {
      out.push({
        kind: row.eventType === 'leaf_inserted' ? 'inserted' : 'updated',
        leafIndex: BigInt(row.leafIndex),
        leaf: BigInt(row.leaf),
        root: BigInt(row.root),
        blockNumber: BigInt(row.blockNumber),
        logIndex: position,
      });
    });
  } catch {
    return null;
  }
  return out;
}

export type AssembledKeystore = { leaves: bigint[]; lastRoot: bigint | null; newestBlock: bigint | null };

/**
 * The leaf array the events describe, or null when they leave a hole (an
 * insert past the end, an update of a leaf that was never inserted). Same
 * placement as the SDK's KeystoreInteractor: by index, in chain order.
 */
export function assembleKeystore(events: readonly KeystoreEvent[]): AssembledKeystore | null {
  const ordered = [...events].sort((a, b) => (
    a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex
  ));
  const leaves: bigint[] = [];
  let lastRoot: bigint | null = null;
  let newestBlock: bigint | null = null;
  for (const event of ordered) {
    const index = Number(event.leafIndex);
    if (!Number.isSafeInteger(index) || index < 0) return null;
    if (event.kind === 'inserted') {
      if (index > leaves.length) return null;
      leaves[index] = event.leaf;
    } else {
      if (index >= leaves.length) return null;
      leaves[index] = event.leaf;
    }
    lastRoot = event.root;
    newestBlock = event.blockNumber;
  }
  return { leaves, lastRoot, newestBlock };
}

export type KeystoreCorrection = {
  events: KeystoreEvent[];
  leaves: `0x${string}`[];
  /** The root every event above was verified against. */
  root: bigint;
  /** The chain head the correction was verified at. */
  head: bigint;
};

const STORE_FLAG = '__ppv2KeystoreCorrections';

/**
 * Chain AND address. Production deployments reuse one keystore address on
 * several chains, so an address alone would let a repair on one chain replace
 * another chain's valid leaves, or a healthy check delete them.
 */
function correctionKey(chainId: number, keystore: string): string {
  return `${chainId}:${keystore.toLowerCase()}`;
}

function corrections(): Map<string, KeystoreCorrection> {
  const holder = globalThis as Record<string, unknown>;
  const existing = holder[STORE_FLAG] as Map<string, KeystoreCorrection> | undefined;
  if (existing) return existing;
  const created = new Map<string, KeystoreCorrection>();
  holder[STORE_FLAG] = created;
  return created;
}

/** The verified chain-rebuilt leaves for a chain, or undefined while the ASP's copy is right. */
export function getKeystoreCorrection(chainId: number, keystore: string): KeystoreCorrection | undefined {
  return corrections().get(correctionKey(chainId, keystore));
}

export function setKeystoreCorrection(chainId: number, keystore: string, correction: KeystoreCorrection): void {
  corrections().set(correctionKey(chainId, keystore), correction);
}

export function clearKeystoreCorrection(chainId: number, keystore: string): void {
  corrections().delete(correctionKey(chainId, keystore));
}

export function resetKeystoreCorrections(): void {
  corrections().clear();
}

/**
 * What the SDK's keystore interactor should hand out. The interactor caches a
 * leaf set per instance and only ever extends it, so one that read the ASP's
 * short copy keeps it for the session. The held correction replaces it, unless
 * the interactor's own set already extends the correction (a registration that
 * landed after the check).
 */
export function reconcileKeystoreLeaves(
  sdkLeaves: readonly (string | undefined)[],
  correction: Pick<KeystoreCorrection, 'leaves'> | undefined,
): readonly (string | undefined)[] {
  if (!correction) return sdkLeaves;
  const held = correction.leaves;
  if (sdkLeaves.length < held.length) return held;
  for (let i = 0; i < held.length; i += 1) {
    if (sdkLeaves[i]?.toLowerCase() !== held[i].toLowerCase()) return held;
  }
  return sdkLeaves;
}

/**
 * The SDK's keystore interactor caches the leaves it read and only extends them,
 * so one that read the ASP's short copy keeps it for its whole session. Every
 * leaf set it hands out (a withdrawal's and an exit's alike) goes through
 * reconcileKeystoreLeaves with the correction the grid holds. A read of held
 * data: it sends no request. If the interactor's own read fails and a
 * correction is held, the correction answers instead of the failure.
 */
export function correctKeystoreInteractor<T extends { getKeystoreLeaves: () => Promise<any> }>(
  interactor: T,
  chainId: number,
  keystoreAddress: string,
): T {
  return new Proxy(interactor, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === 'getKeystoreLeaves' && typeof value === 'function') {
        return async () => {
          const correction = getKeystoreCorrection(chainId, keystoreAddress);
          let leaves: readonly (string | undefined)[];
          try {
            leaves = await (value as () => Promise<string[]>).call(target);
          } catch (error) {
            if (correction) return [...correction.leaves];
            throw error;
          }
          return [...reconcileKeystoreLeaves(leaves, correction)];
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export type KeystoreRootDeps = {
  chainId: number;
  /** The Keystore contract address: the correction store is keyed by it. */
  keystoreAddress: string;
  /** The Keystore's first block: the floor of a full rebuild. */
  fromBlock: bigint;
  readHead: () => Promise<bigint>;
  /** Keystore.currentRoot() at `block`. A pool-wide view call with no argument. */
  readRoot: (block: bigint) => Promise<bigint>;
  /** The keystore leaf rows the feed grid holds, or null when none are held. Never a request. */
  heldRows: () => Promise<readonly KeystoreLeafRowLike[] | null>;
  /**
   * ONE eth_getLogs call for LeafInserted / LeafUpdated over [from, to],
   * inclusive. No retry, no chunking: the guard owns both, and counts every
   * call against the repair's budget.
   */
  getEvents: (from: bigint, to: bigint) => Promise<KeystoreEvent[]>;
  /** The widest window one getEvents call may span. The chain's own cap where it has one. */
  windowBlocks?: bigint;
  /** Hard cap on getEvents calls for one repair, both tiers together. Default 60. */
  maxRequestsPerRepair?: number;
  /** The Merkle root of the leaves, as the proof builds it. */
  computeRoot: (leaves: readonly `0x${string}`[]) => Promise<bigint>;
  now?: () => number;
  /** Minimum gap between repair attempts on a chain, success or not. Default 10 minutes. */
  repairCooldownMs?: number;
  onDecision?: (line: string) => void;
};

export type KeystoreRootVerdict =
  | { status: 'current' }
  | { status: 'repaired'; tier: 'held' | 'tail' | 'full' }
  | { status: 'unrepaired'; reason: string }
  | { status: 'unchecked'; reason: string };

const DEFAULT_REPAIR_COOLDOWN_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const DEFAULT_MAX_REQUESTS = 60;
const DEFAULT_WINDOW_BLOCKS = 100_000n;

type ChainRepairState = {
  /** No repair attempt, of either tier, before this instant. */
  nextAttemptAt: number;
  /** Consecutive failed repairs: each doubles the wait, up to an hour. */
  failures: number;
  /** A window the chain's RPC proved it accepts, kept across repairs. */
  windowBlocks?: bigint;
};

// On globalThis like the correction store: the web bundle can evaluate this
// module more than once, and a second instance with its own empty map is a
// second chance to hit the provider.
const STATE_FLAG = '__ppv2KeystoreRepairState';

function repairStates(): Map<number, ChainRepairState> {
  const holder = globalThis as Record<string, unknown>;
  const existing = holder[STATE_FLAG] as Map<number, ChainRepairState> | undefined;
  if (existing) return existing;
  const created = new Map<number, ChainRepairState>();
  holder[STATE_FLAG] = created;
  return created;
}

export function resetKeystoreRootGuardState(): void {
  repairStates().clear();
  resetKeystoreCorrections();
}

class RepairBudgetError extends Error {}

/**
 * Walks [from, to] in windows through `readWindow`, one call at a time. Every call
 * counts against `budget`; a repair that cannot fit is refused BEFORE its
 * first request. A range cap is learned once (from the message, else halved)
 * and the walk goes on at the new size; a rate limit or any other failure
 * stops the walk and propagates. Nothing here retries.
 */
async function boundedSweep(
  readWindow: (from: bigint, to: bigint) => Promise<KeystoreEvent[]>,
  from: bigint,
  to: bigint,
  state: ChainRepairState,
  budget: { left: number },
  windowDefault: bigint,
): Promise<KeystoreEvent[]> {
  const out: KeystoreEvent[] = [];
  if (from > to) return out;
  let window = state.windowBlocks ?? windowDefault;
  let shrinks = 0;
  let cursor = from;
  const planned = () => Number((to - cursor) / window) + 1;
  if (planned() > budget.left) throw new RepairBudgetError(`needs ${planned()} log calls, budget is ${budget.left}`);
  while (cursor <= to) {
    if (budget.left <= 0) throw new RepairBudgetError('log call budget spent');
    const end = cursor + window - 1n < to ? cursor + window - 1n : to;
    budget.left -= 1;
    try {
      for (const event of await readWindow(cursor, end)) out.push(event);
      cursor = end + 1n;
    } catch (error) {
      if (isRateLimitError(error) || classifyLimitError(error) !== 'range' || end <= cursor || shrinks >= 3) throw error;
      const cap = parseBlockRangeCap(error);
      window = cap !== null && cap < window ? cap : window / 2n;
      if (window < 1n) throw error;
      shrinks += 1;
      state.windowBlocks = window;
      if (planned() > budget.left) throw new RepairBudgetError(`needs ${planned()} log calls, budget is ${budget.left}`);
    }
  }
  return out;
}

async function verified(
  deps: KeystoreRootDeps,
  events: KeystoreEvent[],
  chainRoot: bigint,
): Promise<KeystoreCorrection | null> {
  const assembled = assembleKeystore(events);
  if (!assembled || assembled.leaves.length === 0) return null;
  // Provenance first: it costs nothing. The root the last event produced must be the chain's.
  if (assembled.lastRoot !== chainRoot) return null;
  const leaves = assembled.leaves.map(leafHex);
  if (await deps.computeRoot(leaves) !== chainRoot) return null;
  return { events, leaves, root: chainRoot, head: 0n };
}

/**
 * One grid instant. Reads the chain head and the keystore's current root (two
 * argument-free reads); nothing else when the held leaves are right.
 */
export async function checkKeystoreRoot(deps: KeystoreRootDeps): Promise<KeystoreRootVerdict> {
  const log = (line: string) => { try { deps.onDecision?.(`keystore-root chain=${deps.chainId} ${line}`); } catch { /* ignore */ } };
  const now = deps.now ?? (() => Date.now());
  const head = await deps.readHead();
  const chainRoot = await deps.readRoot(head);
  const held = getKeystoreCorrection(deps.chainId, deps.keystoreAddress);

  if (held && held.root === chainRoot) {
    log('correction still matches the chain');
    return { status: 'repaired', tier: 'held' };
  }

  const rowEvents = eventsFromRows(await deps.heldRows());
  if (rowEvents) {
    const ok = await verified(deps, rowEvents, chainRoot);
    if (ok) {
      // Never delete a held correction just because the snapshot verifies: an
      // SDK interactor that cached the short list has already moved its cursor
      // past the missing event, and would return it again. The verified
      // snapshot REPLACES the correction, so existing sessions keep getting
      // complete leaves.
      if (held) setKeystoreCorrection(deps.chainId, deps.keystoreAddress, { ...ok, head });
      return { status: 'current' };
    }
  } else if (!held) {
    // Nothing held, so nothing to compare. The proof path sweeps the chain itself.
    return { status: 'unchecked', reason: 'no keystore leaves held' };
  }

  // ONE repair attempt per chain per cooldown, whatever happens in it: the
  // tail and the whole-history tiers share it, and so do failures, which push
  // the next attempt out further (x2 each, up to an hour). A provider that
  // rejects or rate-limits us is therefore asked about once, then left alone.
  const states = repairStates();
  const state: ChainRepairState = states.get(deps.chainId) ?? { nextAttemptAt: 0, failures: 0 };
  states.set(deps.chainId, state);
  const cooldown = deps.repairCooldownMs ?? DEFAULT_REPAIR_COOLDOWN_MS;
  if (now() < state.nextAttemptAt) {
    return { status: 'unrepaired', reason: 'repair is backing off' };
  }
  const attemptedAt = now();
  state.nextAttemptAt = attemptedAt + cooldown;
  const fail = (reason: string): KeystoreRootVerdict => {
    state.failures += 1;
    state.nextAttemptAt = attemptedAt + Math.min(cooldown * 2 ** state.failures, MAX_BACKOFF_MS);
    log(`repair failed (${reason}); next attempt in ${Math.round((state.nextAttemptAt - attemptedAt) / 60_000)} min`);
    return { status: 'unrepaired', reason };
  };
  const succeed = (tier: 'tail' | 'full', candidate: KeystoreCorrection): KeystoreRootVerdict => {
    state.failures = 0;
    setKeystoreCorrection(deps.chainId, deps.keystoreAddress, { ...candidate, head });
    log(`repaired from the ${tier === 'tail' ? 'tail' : 'full history'}`);
    return { status: 'repaired', tier };
  };

  log('held leaves do not reproduce the chain root; rebuilding from the chain');
  const budget = { left: deps.maxRequestsPerRepair ?? DEFAULT_MAX_REQUESTS };
  const windowDefault = deps.windowBlocks ?? DEFAULT_WINDOW_BLOCKS;
  const sweep = (from: bigint, to: bigint) => boundedSweep(deps.getEvents, from, to, state, budget, windowDefault);
  let reason = 'rebuilt leaves do not reproduce the chain root';

  // Tier 1: the tail above the newest event already held. The held set is
  // never trusted: the result must reproduce currentRoot.
  const base = held?.events ?? rowEvents ?? [];
  const newest = base.reduce<bigint>((n, e) => (e.blockNumber > n ? e.blockNumber : n), deps.fromBlock);
  const tailFrom = alignLogScanStart(newest, deps.fromBlock);
  try {
    const tail = await sweep(tailFrom, head);
    const ok = await verified(deps, [...base.filter((e) => e.blockNumber < tailFrom), ...tail], chainRoot);
    if (ok) return succeed('tail', ok);
  } catch (error) {
    reason = `tail read failed: ${error instanceof Error ? error.message : String(error)}`;
    // A provider that refused or rate-limited the tail is not asked again for the history.
    if (!(error instanceof RepairBudgetError)) return fail(reason);
  }

  // Tier 2: the whole history, same budget. Two reads: a lossy provider can
  // return different logs for the same range.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const ok = await verified(deps, await sweep(deps.fromBlock, head), chainRoot);
      if (ok) return succeed('full', ok);
    } catch (error) {
      reason = `full read failed: ${error instanceof Error ? error.message : String(error)}`;
      return fail(reason);
    }
  }
  return fail(reason);
}
