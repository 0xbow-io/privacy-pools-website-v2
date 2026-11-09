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

function corrections(): Map<string, KeystoreCorrection> {
  const holder = globalThis as Record<string, unknown>;
  const existing = holder[STORE_FLAG] as Map<string, KeystoreCorrection> | undefined;
  if (existing) return existing;
  const created = new Map<string, KeystoreCorrection>();
  holder[STORE_FLAG] = created;
  return created;
}

/** The verified chain-rebuilt leaves for a chain, or undefined while the ASP's copy is right. */
export function getKeystoreCorrection(keystore: string): KeystoreCorrection | undefined {
  return corrections().get(keystore.toLowerCase());
}

export function setKeystoreCorrection(keystore: string, correction: KeystoreCorrection): void {
  corrections().set(keystore.toLowerCase(), correction);
}

export function clearKeystoreCorrection(keystore: string): void {
  corrections().delete(keystore.toLowerCase());
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
  keystoreAddress: string,
): T {
  return new Proxy(interactor, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === 'getKeystoreLeaves' && typeof value === 'function') {
        return async () => {
          const correction = getKeystoreCorrection(keystoreAddress);
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
  /** LeafInserted / LeafUpdated events over [from, to], inclusive, from the chain. */
  getEvents: (from: bigint, to: bigint) => Promise<KeystoreEvent[]>;
  /** The Merkle root of the leaves, as the proof builds it. */
  computeRoot: (leaves: readonly `0x${string}`[]) => Promise<bigint>;
  now?: () => number;
  /** Minimum gap between whole-history rebuilds. Default 10 minutes. */
  fullRebuildCooldownMs?: number;
  onDecision?: (line: string) => void;
};

export type KeystoreRootVerdict =
  | { status: 'current' }
  | { status: 'repaired'; tier: 'held' | 'tail' | 'full' }
  | { status: 'unrepaired'; reason: string }
  | { status: 'unchecked'; reason: string };

const DEFAULT_FULL_COOLDOWN_MS = 10 * 60_000;
const lastFullAttempt = new Map<number, number>();

export function resetKeystoreRootGuardState(): void {
  lastFullAttempt.clear();
  resetKeystoreCorrections();
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
  const held = getKeystoreCorrection(deps.keystoreAddress);

  if (held && held.root === chainRoot) {
    log('correction still matches the chain');
    return { status: 'repaired', tier: 'held' };
  }

  const rowEvents = eventsFromRows(await deps.heldRows());
  if (rowEvents) {
    const ok = await verified(deps, rowEvents, chainRoot);
    if (ok) {
      clearKeystoreCorrection(deps.keystoreAddress);
      return { status: 'current' };
    }
  } else if (!held) {
    // Nothing held, so nothing to compare. The proof path sweeps the chain itself.
    return { status: 'unchecked', reason: 'no keystore leaves held' };
  }

  log('held leaves do not reproduce the chain root; rebuilding from the chain');
  const accept = (candidate: KeystoreCorrection): void => {
    setKeystoreCorrection(deps.keystoreAddress, { ...candidate, head });
  };

  // Tier 1: the tail above the newest event already held. The held set is
  // never trusted: the result must reproduce currentRoot.
  const base = held?.events ?? rowEvents ?? [];
  const newest = base.reduce<bigint>((n, e) => (e.blockNumber > n ? e.blockNumber : n), deps.fromBlock);
  const tailFrom = alignLogScanStart(newest, deps.fromBlock);
  try {
    const tail = await deps.getEvents(tailFrom, head);
    const merged = [...base.filter((e) => e.blockNumber < tailFrom), ...tail];
    const ok = await verified(deps, merged, chainRoot);
    if (ok) {
      accept(ok);
      log('repaired from the tail');
      return { status: 'repaired', tier: 'tail' };
    }
  } catch (error) {
    log(`tail read failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Tier 2: the whole history, at most once per cooldown. Two attempts: a
  // lossy provider can return different logs for the same range.
  const cooldown = deps.fullRebuildCooldownMs ?? DEFAULT_FULL_COOLDOWN_MS;
  const last = lastFullAttempt.get(deps.chainId);
  if (last !== undefined && now() - last < cooldown) {
    return { status: 'unrepaired', reason: 'full rebuild is cooling down' };
  }
  lastFullAttempt.set(deps.chainId, now());
  let reason = 'rebuilt leaves do not reproduce the chain root';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const events = await deps.getEvents(deps.fromBlock, head);
      const ok = await verified(deps, events, chainRoot);
      if (ok) {
        accept(ok);
        log('repaired from the full history');
        return { status: 'repaired', tier: 'full' };
      }
    } catch (error) {
      reason = `full read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { status: 'unrepaired', reason };
}
