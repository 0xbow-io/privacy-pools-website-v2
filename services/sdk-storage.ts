import { Platform } from 'react-native';
import { PAYMENT_REQUEST_KEY_BASE, paymentRequestStateKey } from '@/services/payment-request-store-read';
import { bumpPaymentRequestRevision } from '@/services/payment-request-revision';
import * as SecureStore from 'expo-secure-store';
import { ACTIVE_APP_ENVIRONMENT, envScopedStorageKey } from '@/config/app-environment';
import {
  type PurgeStorage,
  assertPaymentRequestWriteAllowed,
  ownerRecordKeysFromPhysical,
} from '@/services/payment-request-signout-purge';

// IStorageService implementation for the SDK's PaymentRequestService.
// The SDK persists payment-request records (including the per-request
// ephemeral X25519 paymentPrivKey, which is load-bearing — without it
// discovery can't decrypt the recipient's incoming noteData). Default
// in-memory storage loses everything on refresh, so we wire a real
// persistence layer here.
//
// Web → localStorage (synchronous under the hood, wrapped in Promises).
// Native → expo-secure-store. SecureStore values are limited to ~2KB
// per key, which is plenty for the request store (a handful of 1KB
// records max), and the data IS sensitive (paymentPrivKey).

export interface IStorageService {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

// Mirror of the SDK's STORAGE_KEYS so we can range-delete on clear().
// The SDK's adapters prefix this with `<version>:` and suffix with
// `:<chainId>` (and, since 3a3f5f9, `:<owner>`) — see
// PaymentRequestStorageAdapter constructor.
const KNOWN_KEY_PREFIXES = [`${PAYMENT_REQUEST_KEY_BASE}:`];

// Environment scoping happens HERE, at the physical-key boundary, so the SDK's
// logical keys (and every reader that builds them, e.g.
// services/payment-request-store-read.ts) stay unchanged. Prod and staging
// deploy different pools on the same chain ids, and this store holds each
// request's private X25519 key, so the same owner on chain 1 must not see the
// other world's requests after a switch. Staging keeps the bare key.
function physicalKey(logicalKey: string): string {
  return envScopedStorageKey(logicalKey);
}
const PROD_KEY_SUFFIX = envScopedStorageKey('', 'prod');
/** Whether a physical key belongs to the ACTIVE environment (clear() must not touch the other one's). */
export function isActiveEnvironmentPhysicalKey(physical: string, env = ACTIVE_APP_ENVIRONMENT): boolean {
  const isProdKey = physical.endsWith(PROD_KEY_SUFFIX);
  return env === 'prod' ? isProdKey : !isProdKey;
}

// Map-aware JSON round-trip lives in services/json-maps.ts (pure, no
// react-native import) so bun tests can exercise the exact serializers the
// backup paths use; re-exported here for the existing import sites.
import { parseWithMaps, stringifyWithMaps } from '@/services/json-maps';

export { parseWithMaps, stringifyWithMaps };

function isWebWithStorage(): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

class LocalStorageService implements IStorageService {
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = window.localStorage.getItem(physicalKey(key));
      if (raw === null) return null;
      return parseWithMaps(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    // Don't swallow write failures — the SDK persists the per-request
    // `paymentPrivKey` here, and silently dropping a `setItem` for a
    // payment request would leave the seller with a share link they
    // can't discover after refresh. Surface QuotaExceeded /
    // disabled-storage / SecurityError to the caller so the request
    // generation fails loudly instead of producing an unusable link.
    assertPaymentRequestWriteAllowed(key);
    await this.setUnguarded(key, value);
  }

  /** The purge's own rewrite of a record blob; bypasses the signed-out write block. */
  async setUnguarded<T>(key: string, value: T): Promise<void> {
    window.localStorage.setItem(physicalKey(key), stringifyWithMaps(value));
  }

  async delete(key: string): Promise<void> {
    window.localStorage.removeItem(physicalKey(key));
  }

  async clear(): Promise<void> {
    if (!isWebWithStorage()) return;
    // The SDK contract is `clear()` removes ALL entries, but we don't
    // want to nuke unrelated localStorage keys (note storage, payment-
    // request stash, theme preference, …). Scope to our known SDK
    // prefixes only.
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && KNOWN_KEY_PREFIXES.some((p) => k.startsWith(p)) && isActiveEnvironmentPhysicalKey(k)) {
          keysToRemove.push(k);
        }
      }
      for (const k of keysToRemove) window.localStorage.removeItem(k);
    } catch {
      // ignore
    }
  }
}

class SecureStorageService implements IStorageService {
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await SecureStore.getItemAsync(this.scrub(physicalKey(key)));
      if (raw === null) return null;
      return parseWithMaps(raw) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    // Surface SecureStore failures (size > 2KB, keychain locked) so
    // callers can react. Payment-request records contain the
    // load-bearing paymentPrivKey; a silently-failed set would orphan
    // the share link.
    assertPaymentRequestWriteAllowed(key);
    await this.setUnguarded(key, value);
  }

  /** The purge's own rewrite of a record blob; bypasses the signed-out write block. */
  async setUnguarded<T>(key: string, value: T): Promise<void> {
    await SecureStore.setItemAsync(this.scrub(physicalKey(key)), stringifyWithMaps(value));
  }

  async delete(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(this.scrub(physicalKey(key)));
  }

  async clear(): Promise<void> {
    // SecureStore has no enumerate API. Cannot range-delete without
    // tracking keys ourselves. The SDK only calls clear() on explicit
    // request, so leaving this as a no-op on native is acceptable —
    // callers can call delete(key) individually if they need to.
  }

  // SecureStore restricts keys to [A-Za-z0-9._-]. The SDK's keys
  // contain `:` separators (e.g. `v1:payment-request-state:11155111`),
  // so we map those to `.` for the native backend only.
  private scrub(key: string): string {
    return key.replace(/:/g, '.');
  }
}

class InMemoryFallback implements IStorageService {
  private store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }
  async set<T>(key: string, value: T): Promise<void> {
    assertPaymentRequestWriteAllowed(key);
    this.store.set(key, value);
  }

  async setUnguarded<T>(key: string, value: T): Promise<void> {
    this.store.set(key, value);
  }

  keys(): string[] {
    return [...this.store.keys()];
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
  async clear(): Promise<void> {
    this.store.clear();
  }
}

/**
 * One-time migration for the SDK 3a3f5f9 storage-namespacing change.
 * The PaymentRequestStorageAdapter key gained an owner suffix:
 *   old: v1:payment-request-state:<chainId>
 *   new: v1:payment-request-state:<chainId>:<owner lowercase>
 * Records written by the pre-3a3f5f9 SDK live under the un-namespaced
 * key and would be orphaned (the seller couldn't discover payments for
 * open links after the upgrade). Move them under the connected owner's
 * key once, then drop the old key so a different wallet on the same
 * browser can't inherit them. Idempotent and best-effort: any failure
 * just leaves the (recoverable-via-backup-link) records where they are.
 *
 * Returns true when a migration actually moved data.
 */
export async function migratePaymentRequestStateToOwner(
  chainId: number,
  ownerAddress: string,
  storage: IStorageService = getSdkStorageService(),
): Promise<boolean> {
  const oldKey = `${PAYMENT_REQUEST_KEY_BASE}:${chainId}`;
  const newKey = `${PAYMENT_REQUEST_KEY_BASE}:${chainId}:${ownerAddress.toLowerCase()}`;
  try {
    // Already namespaced for this owner — nothing to move; just sweep
    // any leftover legacy key so it can't be mis-attributed later.
    const existingNew = await storage.get(newKey);
    if (existingNew != null) {
      if ((await storage.get(oldKey)) != null) await storage.delete(oldKey);
      return false;
    }
    const legacy = await storage.get(oldKey);
    if (legacy == null) return false;
    // get/set round-trip through the Map-aware (de)serializer, so the
    // record's noteSecretsMap survives the move intact.
    await storage.set(newKey, legacy);
    await storage.delete(oldKey);
    bumpPaymentRequestRevision();
    return true;
  } catch {
    return false;
  }
}

// v2.0 migration: the pure legacy-shape upgrade lives in its own
// react-native-free module; re-exported here for existing importers.
import { upgradeLegacyPaymentRequestState } from '@/services/payment-request-state-migration';
export { upgradeLegacyPaymentRequestState };

/**
 * One-time, idempotent, best-effort storage rewrite applying
 * {@link upgradeLegacyPaymentRequestState} to the owner-keyed
 * payment-request blob. Without it, v2.0's stricter
 * PaymentRequestServiceStateSchema rejects legacy state on load and the
 * session-init recovery path would reset the store (open requests lost).
 */
export async function migratePaymentRequestStateToV2Shape(
  chainId: number,
  ownerAddress: string,
  storage: IStorageService = getSdkStorageService(),
): Promise<boolean> {
  const key = paymentRequestStateKey(chainId, ownerAddress);
  try {
    const state = await storage.get<unknown>(key);
    if (state == null) return false;
    const upgraded = upgradeLegacyPaymentRequestState(state);
    if (upgraded === state) return false;
    await storage.set(key, upgraded);
    bumpPaymentRequestRevision();
    return true;
  } catch {
    return false;
  }
}

let cached: (IStorageService & { setUnguarded<T>(key: string, value: T): Promise<void> }) | null = null;

/**
 * Storage for the sign-out purge: the same backend, except its writes skip the
 * signed-out write block (the purge rewrites a blob it is keeping part of).
 */
export function getPaymentRequestPurgeStorage(): PurgeStorage {
  const storage = getSdkStorageService() as NonNullable<typeof cached>;
  return {
    get: (key) => storage.get(key),
    set: (key, value) => storage.setUnguarded(key, value),
    delete: (key) => storage.delete(key),
  };
}

/**
 * Logical payment-request record keys of `owner` in the ACTIVE environment,
 * when the backend can enumerate (web localStorage, the in-memory fallback).
 * Null on native: SecureStore has no enumerate API, so the caller names the
 * keys itself (one per supported chain).
 */
export function listOwnerPaymentRequestKeys(owner: string): string[] | null {
  const storage = getSdkStorageService();
  if (storage instanceof LocalStorageService) {
    const physical: string[] = [];
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k) physical.push(k);
      }
    } catch {
      return [];
    }
    return ownerRecordKeysFromPhysical(physical, owner, ACTIVE_APP_ENVIRONMENT);
  }
  if (storage instanceof InMemoryFallback) {
    return ownerRecordKeysFromPhysical(storage.keys(), owner, 'staging');
  }
  return null;
}

export function getSdkStorageService(): IStorageService {
  if (cached) return cached;
  if (isWebWithStorage()) {
    cached = new LocalStorageService();
  } else if (Platform.OS !== 'web') {
    cached = new SecureStorageService();
  } else {
    cached = new InMemoryFallback();
  }
  return cached;
}
