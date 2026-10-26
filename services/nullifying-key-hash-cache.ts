import { policedFetch } from '@/services/egress-fetch';
// Local copy of the on-chain Keystore's (account → nullifying-key hash)
// registry, kept in sync with the ASP's bulk /nullifying-key-hashes feed.
//
// Why: the identity check at sign-in and before a deposit used to call
// `Keystore.getNullifyingKeyHash(account)` over the chain RPC, which names the
// user's own account to the RPC provider every session. The ASP serves the
// whole registry, the same bytes to every client, and the check reads the
// local map instead.
//
// Timing: the feed is pulled only by the fixed background grid
// (services/public-feeds.ts), never by a sign-in or a deposit, so the request
// time says nothing about when this user acted.
//
// Trust: the hash is write-once on-chain, so a HIT is always correct, however
// old. A MISS only means "unregistered" while the last successful sync is
// recent (`isNullifyingKeyRegistryFresh`); otherwise callers report 'unknown'.

import { Platform } from 'react-native';
import { envScopedStorageKey } from '@/config/app-environment';
import { ASP_URL } from '@/config/env';
import type { RegistryView } from '@/services/keystore-identity-status';
import { notifyRegistrySynced, onRegistrySynced } from '@/services/keystore-registry-events';
import { getCachedViewingKey, isViewingKeyRegistryFresh } from '@/services/viewing-key-cache';

/** Grid cadence of the delta pull. */
export const NULLIFYING_KEY_HASH_INTERVAL_MS = 5 * 60_000;
/** Retry cadence after a failed pull (divides the interval, as the scheduler requires). */
export const NULLIFYING_KEY_HASH_RETRY_MS = 30_000;
/** A miss is trusted as 'unregistered' only within this age of the last successful sync. */
export const NULLIFYING_KEY_HASH_MAX_AGE_MS = 2 * NULLIFYING_KEY_HASH_INTERVAL_MS + 60_000;
/** Bound on continuation pages in one tick (the server pages only when asked to). */
const MAX_PAGES = 50;

interface AspEntry {
  id: string;
  account: string;
  nullifyingKeyHash: string;
  lastUpdatedBlock: string;
}

interface NullifyingKeyHashesResponse {
  entries: AspEntry[];
  lastSyncedId: string;
  hasMore?: boolean;
}

interface CachedRegistry {
  /** Lowercased account → lowercased 0x + 64 hex hash. */
  byAccount: Record<string, string>;
  lastSyncedId: string;
  /** ms epoch of the last successful sync. Persisted, so a reload within the window is current at once. */
  lastSyncedAt: number;
}

export type NullifyingKeyHashSyncOutcome =
  | { ok: true; appliedEntries: number; lastSyncedId: string }
  | { ok: false; reason: 'not-deployed' | 'network' | 'parse'; error?: unknown };

const STORAGE_PREFIX = 'ppv2_nullifying_key_hashes_v1_';

function cacheScope(chainId: number, keystoreAddress?: string): string {
  const ks = keystoreAddress?.toLowerCase();
  return ks ? `${chainId}_${ks}` : String(chainId);
}

function storageKey(chainId: number, keystoreAddress?: string): string {
  return envScopedStorageKey(`${STORAGE_PREFIX}${cacheScope(chainId, keystoreAddress)}`);
}

// Persisted on web only. The registry is bulk public data that outgrows
// SecureStore's per-item limit on native, where the process also lives far
// longer than a tab; native keeps the in-memory copy the grid fills at launch.
function storageGet(key: string): string | null {
  if (Platform.OS !== 'web') return null;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  if (Platform.OS !== 'web') return;
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // ignore: the in-memory copy still serves this session
  }
}

const memory = new Map<string, CachedRegistry>();
/** ms epoch of the last successful sync, per scope, this process only. */
const lastSyncOk = new Map<string, number>();
/** Set after a 404: this ASP does not serve the feed. A reload retries. */
const aspUnavailable = new Set<string>();

function readRegistry(chainId: number, keystoreAddress?: string): CachedRegistry {
  const scope = cacheScope(chainId, keystoreAddress);
  const inMemory = memory.get(scope);
  if (inMemory) return inMemory;
  let registry: CachedRegistry = { byAccount: {}, lastSyncedId: '0', lastSyncedAt: 0 };
  const raw = storageGet(storageKey(chainId, keystoreAddress));
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<CachedRegistry>;
      if (parsed && typeof parsed.byAccount === 'object' && parsed.byAccount && typeof parsed.lastSyncedId === 'string') {
        registry = {
          byAccount: parsed.byAccount,
          lastSyncedId: parsed.lastSyncedId,
          lastSyncedAt: typeof parsed.lastSyncedAt === 'number' ? parsed.lastSyncedAt : 0,
        };
      }
    } catch {
      // corrupt entry: start over from a bootstrap
    }
  }
  memory.set(scope, registry);
  return registry;
}

function normalizeHash(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const n = BigInt(value);
    if (n <= 0n) return null;
    return `0x${n.toString(16).padStart(64, '0')}`;
  } catch {
    return null;
  }
}

/**
 * Pull everything past the stored cursor. Called ONLY from the background feed
 * grid. The request carries nothing but the server's own cursor.
 */
export async function syncNullifyingKeyHashes(
  chainId: number,
  keystoreAddress?: string,
  /** Injected only by tests; production always goes through the egress policy. */
  send: typeof policedFetch = policedFetch,
): Promise<NullifyingKeyHashSyncOutcome> {
  const scope = cacheScope(chainId, keystoreAddress);
  if (aspUnavailable.has(scope)) return { ok: false, reason: 'not-deployed' };
  const registry = readRegistry(chainId, keystoreAddress);
  const next: CachedRegistry = { byAccount: { ...registry.byAccount }, lastSyncedId: registry.lastSyncedId, lastSyncedAt: registry.lastSyncedAt };
  let applied = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${ASP_URL}/${chainId}/public/nullifying-key-hashes?sinceId=${next.lastSyncedId}`;
    let response: Response;
    try {
      response = await send('asp', ASP_URL, url, { headers: { Accept: 'application/json' } });
    } catch (error) {
      return { ok: false, reason: 'network', error };
    }
    if (response.status === 404) {
      aspUnavailable.add(scope);
      return { ok: false, reason: 'not-deployed' };
    }
    if (!response.ok) return { ok: false, reason: 'network', error: `HTTP ${response.status}` };
    let payload: NullifyingKeyHashesResponse;
    try {
      payload = (await response.json()) as NullifyingKeyHashesResponse;
    } catch (error) {
      return { ok: false, reason: 'parse', error };
    }
    if (!payload || !Array.isArray(payload.entries) || typeof payload.lastSyncedId !== 'string' || !/^\d+$/.test(payload.lastSyncedId)) {
      return { ok: false, reason: 'parse' };
    }
    for (const entry of payload.entries) {
      if (!entry || typeof entry.account !== 'string') return { ok: false, reason: 'parse' };
      const hash = normalizeHash(entry.nullifyingKeyHash);
      // Never advance the cursor past an entry we could not read: it would be lost for good.
      if (!hash) return { ok: false, reason: 'parse' };
      const account = entry.account.toLowerCase();
      if (next.byAccount[account] !== hash) {
        next.byAccount[account] = hash;
        applied += 1;
      }
    }
    next.lastSyncedId = payload.lastSyncedId;
    // Keep each page's progress, so a registry longer than one tick's page
    // budget still advances; only the final page marks the copy current.
    memory.set(scope, next);
    storageSet(storageKey(chainId, keystoreAddress), JSON.stringify(next));
    if (!payload.hasMore) {
      next.lastSyncedAt = Date.now();
      memory.set(scope, next);
      storageSet(storageKey(chainId, keystoreAddress), JSON.stringify(next));
      lastSyncOk.set(scope, next.lastSyncedAt);
      notifyRegistrySynced();
      return { ok: true, appliedEntries: applied, lastSyncedId: next.lastSyncedId };
    }
  }
  return { ok: false, reason: 'network', error: 'too many pages' };
}

/** Pure local read. Never touches the network. */
export function getCachedNullifyingKeyHash(chainId: number, account: string, keystoreAddress?: string): string | null {
  return readRegistry(chainId, keystoreAddress).byAccount[account.toLowerCase()] ?? null;
}

/** True when a sync succeeded recently enough that a miss means "not registered". */
export function isNullifyingKeyRegistryFresh(chainId: number, keystoreAddress?: string, now = Date.now()): boolean {
  const at = Math.max(lastSyncOk.get(cacheScope(chainId, keystoreAddress)) ?? 0, readRegistry(chainId, keystoreAddress).lastSyncedAt);
  return at > 0 && now - at <= NULLIFYING_KEY_HASH_MAX_AGE_MS;
}

/** Test hook. */
export function resetNullifyingKeyHashCacheForTests(): void {
  memory.clear();
  lastSyncOk.clear();
  aspUnavailable.clear();
  ownRegistrations.clear();
}

/**
 * This client's own registrations that the ASP has not served back yet. After
 * our own setAuthPolicy / registerAndRelay / setViewingKey confirms, the bulk
 * feed lags by up to a grid window plus indexing; without this a reopened flow
 * would plan the registration again and revert. Built only from values this
 * client already holds (its own account and key hashes), never from a request.
 * It answers only a registry MISS: a served entry always wins, so it can never
 * hide a registration under a different unlock.
 */
const OWN_REGISTRATION_TTL_MS = 30 * 60_000;
const ownRegistrations = new Map<string, { nullifyingKeyHash: string; viewingKey: string | null; at: number }>();

function ownKey(chainId: number, account: string, keystoreAddress?: string): string {
  return `${cacheScope(chainId, keystoreAddress)}:${account.toLowerCase()}`;
}

export function recordOwnRegistration(
  chainId: number,
  account: string,
  keystoreAddress: string | undefined,
  nullifyingKeyHash: string,
  viewingKey: string | null,
): void {
  const hash = normalizeHash(nullifyingKeyHash);
  if (!hash) return;
  const key = ownKey(chainId, account, keystoreAddress);
  const previous = ownRegistrations.get(key);
  // Same identity only: a different hash means a different unlock, which the chain would refuse anyway.
  if (previous && previous.nullifyingKeyHash !== hash) return;
  ownRegistrations.set(key, {
    nullifyingKeyHash: hash,
    viewingKey: viewingKey?.toLowerCase() ?? previous?.viewingKey ?? null,
    at: Date.now(),
  });
}

/** Both registries for one account, local reads only: no request of any kind. */
export function readRegistryView(chainId: number, account: string, keystoreAddress?: string, now = Date.now()): RegistryView {
  const view: RegistryView = {
    nullifyingKeyHash: getCachedNullifyingKeyHash(chainId, account, keystoreAddress),
    nullifyingFresh: isNullifyingKeyRegistryFresh(chainId, keystoreAddress, now),
    viewingKey: getCachedViewingKey(chainId, account, keystoreAddress),
    viewingFresh: isViewingKeyRegistryFresh(chainId, keystoreAddress, now),
  };
  const own = ownRegistrations.get(ownKey(chainId, account, keystoreAddress));
  if (own && now - own.at <= OWN_REGISTRATION_TTL_MS && view.nullifyingKeyHash == null) {
    view.nullifyingKeyHash = own.nullifyingKeyHash;
    if (own.viewingKey && !view.viewingKey) {
      view.viewingKey = own.viewingKey;
      view.viewingFresh = true;
    }
  }
  return view;
}

/**
 * Resolve once both registries are current for this scope, or after
 * `timeoutMs`. Never fetches: it waits for the background grid's own sync, so
 * the request timing stays the grid's. Returns whether they are current.
 */
export function awaitKeystoreRegistries(chainId: number, keystoreAddress: string | undefined, timeoutMs: number): Promise<boolean> {
  const current = () => isNullifyingKeyRegistryFresh(chainId, keystoreAddress) && isViewingKeyRegistryFresh(chainId, keystoreAddress);
  if (current()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(current());
    };
    const unsubscribe = onRegistrySynced(() => {
      if (current()) finish();
    });
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** Error text for a write refused because the registries are not current yet. */
export const REGISTRY_SYNCING_MESSAGE = 'Still syncing account registrations. Try again in a moment.';
