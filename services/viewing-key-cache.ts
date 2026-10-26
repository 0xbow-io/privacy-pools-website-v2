import { policedFetch } from '@/services/egress-fetch';
// Local cache of the on-chain Keystore's (account → viewing key)
// registry, kept in sync with the ASP's /viewing-keys delta endpoint.
//
// Why cache: pre-flight on every Review Transfer needs to know
// whether the recipient has a registered viewing key. If we ask the
// ASP for THAT specific recipient, the request leaks "sender X is
// interested in Y" through HTTP access logs — same goes for asking
// the chain RPC. The privacy property the protocol relies on demands
// the lookup happen locally.
//
// Failover: if the ASP endpoint returns 404 (not deployed yet on
// this environment), we mark the endpoint unavailable for the
// session and fall back to the chain RPC's `Keystore.viewingKeys()`
// — privacy-leaking, but the only correct thing while we wait for
// the rollout. Once the endpoint is up, the cache populates on
// first sync and stays current via id-cursor deltas.
//
// Storage: per-chain + per-keystore entry in the platform's persistent store
// (web localStorage, native SecureStore). Cursor is the `keystore_event.id`
// bigserial — monotonic per indexed keystore stream, never reused.

import { Platform } from 'react-native';
import { envScopedStorageKey } from '@/config/app-environment';
import * as SecureStore from 'expo-secure-store';
import type { Address, Hex, PublicKey } from '@/services/sdk-types';
import { ASP_URL } from '@/config/env';

type AspKey = {
  id: string;
  account: string;
  viewingKey: string | null;
  lastUpdatedBlock: string;
};

interface ViewingKeysResponse {
  keys: AspKey[];
  lastSyncedId: string;
}

interface CachedRegistry {
  // Lowercased account → 32-byte X25519 viewing key (0x + 64 hex).
  // Deregistered accounts are removed from this map entirely.
  byAccount: Record<string, string>;
  // Highest keystore_event.id we've applied. Pass back as sinceId on
  // the next sync to fetch only deltas.
  lastSyncedId: string;
  // ms epoch of the last successful sync. Used to age out cache
  // when the indexer has been silent for an unusually long time
  // (e.g., misconfigured deployment) and the cache might be wrong
  // about freshness — a soft hint, not a correctness boundary.
  lastSyncedAt: number;
}

const STORAGE_PREFIX = 'ppv2_viewing_keys_v1_';
function cacheScope(chainId: number, keystoreAddress?: string): string {
  const normalizedKeystore = keystoreAddress?.toLowerCase();
  return normalizedKeystore ? `${chainId}_${normalizedKeystore}` : String(chainId);
}

function storageKey(chainId: number, keystoreAddress?: string): string {
  // Environment-scoped as well: a chain with no keystore in the call falls back
  // to a chain-only scope, which prod and staging would otherwise share.
  return envScopedStorageKey(`${STORAGE_PREFIX}${cacheScope(chainId, keystoreAddress)}`);
}

function storageGetItem(key: string): string | null {
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage === 'undefined') return null;
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  try {
    return SecureStore.getItem(key);
  } catch {
    return null;
  }
}

function storageSetItem(key: string, value: string): void {
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(key, value);
    } catch {
      // ignore
    }
    return;
  }
  try {
    SecureStore.setItem(key, value);
  } catch {
    // ignore
  }
}

function readRegistry(chainId: number, keystoreAddress?: string): CachedRegistry {
  const raw = storageGetItem(storageKey(chainId, keystoreAddress));
  if (!raw) return { byAccount: {}, lastSyncedId: '0', lastSyncedAt: 0 };
  try {
    const parsed = JSON.parse(raw) as Partial<CachedRegistry>;
    return {
      byAccount: parsed.byAccount ?? {},
      lastSyncedId: parsed.lastSyncedId ?? '0',
      lastSyncedAt: parsed.lastSyncedAt ?? 0,
    };
  } catch {
    return { byAccount: {}, lastSyncedId: '0', lastSyncedAt: 0 };
  }
}

function writeRegistry(chainId: number, registry: CachedRegistry, keystoreAddress?: string): void {
  storageSetItem(storageKey(chainId, keystoreAddress), JSON.stringify(registry));
}

// Per-process flag set when the ASP returns 404 once. Avoids
// repeated 404 round-trips for the rest of the session — once the
// endpoint is deployed, a fresh page load resets this.
const aspUnavailable = new Map<string, boolean>();

/**
 * Cadence for the full registry re-pull — one per scope per window, driven by
 * the fixed background feed grid (services/public-feeds.ts), never by a
 * lookup. A pull that fires only after a specific recipient's cache miss
 * leaks the TIMING of that lookup even though the bulk payload hides the
 * address itself (review of #130); the grid asks on the same schedule for
 * every client regardless of what anyone is looking up.
 *
 * Five minutes. A lookup already runs the cheap delta (`sinceId`) itself, so a
 * recipient who registered a minute ago is found without this; the full pull
 * only repairs what a delta cursor can miss (deregistrations, skipped ids). At
 * one minute it was three requests a minute across the chains for that.
 */
export const FULL_RESYNC_INTERVAL_MS = 5 * 60_000;
// Stamped only on a SUCCESSFUL full pull — a failed attempt must not go quiet
// for a whole window while the cache stays possibly-incomplete; the next grid
// tick retries it instead.
const lastFullResyncOk = new Map<string, number>();
// Whether the most recent full-pull ATTEMPT for this scope failed. Cleared by
// the next success. Consulted by `lookupViewingKey` so a miss that follows a
// known-failed full pull is not reported as a confident 'unregistered'.
const fullResyncFailed = new Map<string, boolean>();

function dueForFullResync(chainId: number, keystoreAddress?: string): boolean {
  const scope = cacheScope(chainId, keystoreAddress);
  return Date.now() - (lastFullResyncOk.get(scope) ?? 0) >= FULL_RESYNC_INTERVAL_MS;
}

/**
 * Scheduled full registry re-pull for one scope. Called from the fixed
 * background feed grid (services/public-feeds.ts) — never from a lookup, so
 * the request's TIMING says nothing about which recipient anyone just
 * checked.
 *
 * Only a success resets the throttle (review of #130): a failure is
 * propagated to the caller (the scheduler's feed state) and recorded so
 * `lookupViewingKey` can stop trusting a cache miss as a definitive answer
 * until a pull actually lands, rather than silently carrying on as if the
 * registry were complete.
 */
export async function refreshViewingKeyRegistry(chainId: number, keystoreAddress?: string): Promise<SyncOutcome> {
  const scope = cacheScope(chainId, keystoreAddress);
  if (!dueForFullResync(chainId, keystoreAddress)) {
    const registry = readRegistry(chainId, keystoreAddress);
    return { ok: true, appliedDeltas: 0, lastSyncedId: registry.lastSyncedId };
  }
  const outcome = await syncViewingKeys(chainId, keystoreAddress, true);
  if (outcome.ok) {
    lastFullResyncOk.set(scope, Date.now());
    fullResyncFailed.delete(scope);
  } else {
    fullResyncFailed.set(scope, true);
  }
  return outcome;
}

export type SyncOutcome =
  | { ok: true; appliedDeltas: number; lastSyncedId: string }
  | { ok: false; reason: 'disabled' | 'not-deployed' | 'network' | 'parse'; error?: unknown };

/**
 * Fetch new entries since the cached `lastSyncedId` and merge them
 * into the local registry. Returns the outcome so the caller can
 * decide whether to trust the cache for misses.
 *
 * On a 404 from the ASP we set the per-session "unavailable" flag
 * so subsequent calls short-circuit instead of hammering the
 * endpoint. Recovery is one page reload after the endpoint deploys.
 */
export async function syncViewingKeys(
  chainId: number,
  keystoreAddress?: string,
  /** Re-pull the whole registry (sinceId=0) instead of the delta. */
  fromStart = false,
): Promise<SyncOutcome> {
  const scope = cacheScope(chainId, keystoreAddress);
  if (aspUnavailable.get(scope)) {
    return { ok: false, reason: 'not-deployed' };
  }
  const registry = readRegistry(chainId, keystoreAddress);
  const sinceId = fromStart ? '0' : registry.lastSyncedId;
  const url = `${ASP_URL}/${chainId}/public/viewing-keys?sinceId=${sinceId}`;
  let response: Response;
  try {
    response = await policedFetch('asp', ASP_URL, url, {
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    return { ok: false, reason: 'network', error };
  }
  if (response.status === 404) {
    aspUnavailable.set(scope, true);
    return { ok: false, reason: 'not-deployed' };
  }
  if (!response.ok) {
    return { ok: false, reason: 'network', error: `HTTP ${response.status}` };
  }

  let payload: ViewingKeysResponse;
  try {
    payload = (await response.json()) as ViewingKeysResponse;
  } catch (error) {
    return { ok: false, reason: 'parse', error };
  }
  if (!payload || !Array.isArray(payload.keys) || typeof payload.lastSyncedId !== 'string') {
    return { ok: false, reason: 'parse' };
  }

  let applied = 0;
  for (const entry of payload.keys) {
    if (!entry || typeof entry.account !== 'string') continue;
    const account = entry.account.toLowerCase();
    if (entry.viewingKey == null) {
      // Deregistration — drop from the local map.
      if (account in registry.byAccount) {
        delete registry.byAccount[account];
        applied += 1;
      }
      continue;
    }
    if (registry.byAccount[account] !== entry.viewingKey) {
      registry.byAccount[account] = entry.viewingKey;
      applied += 1;
    }
  }

  registry.lastSyncedId = payload.lastSyncedId;
  registry.lastSyncedAt = Date.now();
  writeRegistry(chainId, registry, keystoreAddress);

  return { ok: true, appliedDeltas: applied, lastSyncedId: payload.lastSyncedId };
}

/**
 * Pure cache lookup. Returns the X25519 public key for the account,
 * or `null` if the account isn't in the local registry. Does NOT
 * fall back to the network; combine with `syncViewingKeys` for
 * freshness, or use `lookupViewingKey` for the full pre-flight flow.
 */
export function getCachedViewingKey(chainId: number, account: Address | string, keystoreAddress?: string): PublicKey | null {
  const registry = readRegistry(chainId, keystoreAddress);
  const key = registry.byAccount[account.toLowerCase()];
  return (key as PublicKey | undefined) ?? null;
}

export interface RpcFallback {
  /** Last-resort lookup against `Keystore.viewingKeys(account)`. */
  getViewingKey(account: Address): Promise<Hex | string>;
}

export interface LookupResult {
  viewingKey: PublicKey | null;
  /** Where the answer came from, useful for error reporting/UI. */
  source: 'cache' | 'rpc';
  /** True when the ASP endpoint is responding. False after a 404. */
  aspAvailable: boolean;
  /** The RPC fallback threw: a null `viewingKey` means unknown, not unregistered. */
  lookupFailed?: boolean;
}

export interface LookupViewingKeyOptions {
  /**
   * Keystore contract whose registry is being queried. Required for profile
   * safety: Sepolia's current and legacy pool profiles use different keystores.
   */
  keystoreAddress?: Address | string;
  /**
   * Set false when the ASP bulk endpoint is not known to serve this keystore.
   * The lookup then skips local/ASP cache data and asks the selected keystore
   * contract through the caller's RPC fallback.
   */
  useAspCache?: boolean;
}

function isZeroLikeKey(key: string | null | undefined): boolean {
  if (!key) return true;
  return /^0x0*$/i.test(key);
}

/**
 * Pre-flight lookup: sync deltas from the ASP, look up locally, and
 * fall through to RPC only when the endpoint isn't deployed yet.
 *
 * Privacy: when the ASP is available, neither the ASP nor the chain
 * RPC ever sees the recipient address — sync pulls the whole
 * registry slice (same payload for everyone), lookup is a local
 * map read. RPC fallback fires while the endpoint is being rolled out, after a
 * cache miss on a transient sync failure, or when a caller disables ASP cache
 * for a keystore the endpoint is not known to serve.
 */
export async function lookupViewingKey(
  chainId: number,
  account: Address,
  rpcFallback: RpcFallback,
  options: LookupViewingKeyOptions = {},
): Promise<LookupResult> {
  const { keystoreAddress, useAspCache = true } = options;
  const sync: SyncOutcome = useAspCache
    ? await syncViewingKeys(chainId, keystoreAddress)
    : { ok: false, reason: 'disabled' };

  // A synced registry answers straight from the local map: a HIT is always
  // trustworthy (the account really is registered). A MISS is only
  // trustworthy as 'unregistered' when the most recent full re-pull for this
  // scope actually succeeded — the delta cursor alone can skip entries, and a
  // FAILED full pull means the registry may still be incomplete in a way
  // this miss cannot tell apart from "really unregistered". Reporting that
  // as a confident answer could route a registered recipient through the
  // unregistered / one-time-link flow (review of #130), so it falls through
  // to the stale-cache/RPC handling below instead.
  //
  // The full pull itself no longer runs from here: it used to fire on the
  // first miss of the throttle window, which made THIS lookup's timing
  // announce the moment a specific recipient was checked, even though the
  // bulk payload hides who. It now runs on the fixed background feed grid
  // (services/public-feeds.ts refreshViewingKeyRegistry) on the same schedule
  // for every client regardless of what anyone looks up.
  if (sync.ok) {
    const cached = getCachedViewingKey(chainId, account, keystoreAddress);
    if (cached) {
      return { viewingKey: isZeroLikeKey(cached) ? null : cached, source: 'cache', aspAvailable: true };
    }
    if (!fullResyncFailed.get(cacheScope(chainId, keystoreAddress))) {
      return { viewingKey: null, source: 'cache', aspAvailable: true };
    }
  }

  if (!sync.ok && sync.reason !== 'not-deployed' && sync.reason !== 'disabled') {
    // Stale-cache path: ASP is up but the delta fetch hit a transient error.
    // Trusting whatever's in localStorage gives the privacy-correct answer
    // for hits; misses fall through to RPC because we can't tell whether
    // they're "unregistered" or "a sync we missed would have added them."
    const cached = getCachedViewingKey(chainId, account, keystoreAddress);
    if (cached) {
      return {
        viewingKey: isZeroLikeKey(cached) ? null : cached,
        source: 'cache',
        aspAvailable: true,
      };
    }
  }

  // 404 (endpoint not deployed) or stale-cache miss: ask the chain
  // RPC. This is per-recipient and leaks intent to the chain RPC
  // provider, but it's the only way to get a definitive answer
  // without the ASP endpoint.
  try {
    const key = await rpcFallback.getViewingKey(account);
    return {
      viewingKey: isZeroLikeKey(key) ? null : (key as PublicKey),
      source: 'rpc',
      aspAvailable: sync.ok,
    };
  } catch {
    return { viewingKey: null, source: 'rpc', aspAvailable: sync.ok, lookupFailed: true };
  }
}

/**
 * Wipe the cached registry for a chain. Useful after the user
 * manually disconnects, rotates wallets, or after a schema bump.
 */
export function clearViewingKeysCache(chainId: number, keystoreAddress?: string): void {
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(storageKey(chainId, keystoreAddress));
    } catch {
      // ignore
    }
  } else {
    try {
      SecureStore.deleteItemAsync(storageKey(chainId, keystoreAddress)).catch(() => undefined);
    } catch {
      // ignore
    }
  }
  aspUnavailable.delete(cacheScope(chainId, keystoreAddress));
}

/**
 * True when the grid's full re-pull for this scope succeeded within the last two
 * windows and has not failed since, so the local map can stand in for the chain
 * (a hit is current, a miss means unregistered). Pure local state, no request.
 */
export function isViewingKeyRegistryFresh(chainId: number, keystoreAddress?: string, now = Date.now()): boolean {
  const scope = cacheScope(chainId, keystoreAddress);
  const at = lastFullResyncOk.get(scope);
  return at !== undefined && !fullResyncFailed.get(scope) && now - at <= 2 * FULL_RESYNC_INTERVAL_MS + 60_000;
}
