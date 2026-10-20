/**
 * Where the Stellar account export lives in the browser.
 *
 * The export holds every note's secrets (noteSecret, depositSecret), so it is
 * kept in sessionStorage: it survives a refresh within the tab and is gone
 * when the tab closes. A new tab rediscovers the notes from chain. Same
 * decision as the EVM export in components/sdk-provider.tsx.
 *
 * Older builds wrote it to localStorage (`ppv2_stellar_account_*`), and before
 * that the SDK's own LocalStorageService kept the note-manager state under
 * `ppv2_stellar_<chainId>_<G…>_…`. Both are plaintext secrets with no expiry,
 * so they are deleted at load, never read.
 *
 * Payment-request records are kept in localStorage too, like EVM's, by
 * stellar-request-storage.ts under their own key (not matched here).
 *
 * Pure module (no react-native, no SDK) so it is bun-testable.
 */

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

const ACCOUNT_PREFIX = 'ppv2_stellar_account_';
// The SDK's LocalStorageService namespace: ppv2_stellar_<chainId>_<G-address>_…
const SDK_STATE_PATTERN = /^ppv2_stellar_\d+_G[A-Z2-7]{55}_/;

export function accountStorageKey(chainId: number, address: string): string {
  return `${ACCOUNT_PREFIX}${chainId}_${address}`;
}

function sessionStore(): StorageLike | null {
  try {
    return (globalThis as { sessionStorage?: StorageLike }).sessionStorage ?? null;
  } catch {
    return null;
  }
}

function localStore(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Whether a localStorage key is a plaintext Stellar account copy from an older build. */
export function isLegacyStellarAccountKey(key: string): boolean {
  return key.startsWith(ACCOUNT_PREFIX) || SDK_STATE_PATTERN.test(key);
}

/** Deletes every plaintext Stellar account copy an older build left in localStorage. */
export function purgeLegacyStellarAccountCopies(storage: StorageLike | null = localStore()): number {
  if (!storage) return 0;
  try {
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && isLegacyStellarAccountKey(key)) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
    return stale.length;
  } catch {
    return 0;
  }
}

export function readSessionAccount<T>(chainId: number, address: string, storage: StorageLike | null = sessionStore()): T | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(accountStorageKey(chainId, address));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** True when the copy was written. */
export function writeSessionAccount(chainId: number, address: string, value: unknown, storage: StorageLike | null = sessionStore()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(accountStorageKey(chainId, address), JSON.stringify(value));
    return true;
  } catch {
    // Quota or a blocked store: the next tab simply rediscovers from chain.
    return false;
  }
}
