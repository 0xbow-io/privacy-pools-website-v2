/**
 * Where a Stellar account's payment requests persist: localStorage, like the
 * EVM request store (services/sdk-storage.ts). A blind request's record holds
 * random note secrets that nothing else can rebuild, so it must outlive the
 * tab: the account copy in sessionStorage (stellar-account-storage.ts) is gone
 * when the tab closes, and without the record a payment to the request is
 * never found.
 *
 * Same protection as EVM: the SDK records as they are (plaintext, note
 * secrets included, no payment private key, which the SDK re-derives), one
 * key per account and chain, scoped to the app environment with the same
 * envScopedStorageKey EVM uses. Only the requests are kept here, never the
 * notes. The request list rows (public link data) ride along so the Payment
 * Requests list survives a reload too.
 *
 * Writes only ever add: a record already stored and missing from a later
 * export stays, so a failed restore can never erase one. The one removal is
 * the sign-out purge, and it takes only the records the user is proven to
 * hold a backup of (markStellarRequestsBackedUp says what counts).
 *
 * Pure module (no react-native, no SDK) so it is bun-testable.
 */
import { ACTIVE_APP_ENVIRONMENT, envScopedStorageKey, type AppEnvironment } from '@/config/app-environment';
import type { SessionPaymentRequest } from '@/services/session-payment-requests';
import { furtherRequestCopy, ownRequestRecords } from '@/services/stellar/stellar-backup';
import { stellarBlindRequestId } from '@/services/stellar/stellar-request';

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const STELLAR_REQUEST_KEY_BASE = 'v1:stellar-payment-request-state';

export type StoredStellarRequests = {
  /** The SDK's payment-request records (exportAccount().paymentRequests). */
  records: unknown[];
  rows: SessionPaymentRequest[];
  /** paymentIds (lowercase) a successfully downloaded backup file holds. */
  backedUp: string[];
};

export function stellarRequestStorageKey(chainId: number, owner: string, env: AppEnvironment = ACTIVE_APP_ENVIRONMENT): string {
  return envScopedStorageKey(`${STELLAR_REQUEST_KEY_BASE}:${chainId}:${owner}`, env);
}

function localStore(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

function idOf(record: unknown): string | null {
  const id = (record as { paymentId?: unknown } | null)?.paymentId;
  return typeof id === 'string' ? id.toLowerCase() : null;
}

/** `first`, then every entry of `rest` whose key `first` does not have. */
function union<T>(first: readonly T[], rest: readonly T[], key: (v: T) => string | null): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const v of [...first, ...rest]) {
    const k = key(v);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

export function readStoredStellarRequests(
  chainId: number,
  owner: string,
  storage: StorageLike | null = localStore(),
  env: AppEnvironment = ACTIVE_APP_ENVIRONMENT,
): StoredStellarRequests {
  const empty: StoredStellarRequests = { records: [], rows: [], backedUp: [] };
  if (!storage) return empty;
  try {
    const raw = storage.getItem(stellarRequestStorageKey(chainId, owner, env));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<StoredStellarRequests> | null;
    const records = ownRequestRecords(parsed?.records, owner);
    const rows = Array.isArray(parsed?.rows)
      ? parsed.rows.filter((r): r is SessionPaymentRequest =>
        !!r && typeof r === 'object' && typeof r.requestId === 'string'
        && r.chainId === chainId && r.owner === owner.toLowerCase())
      : [];
    const backedUp = Array.isArray(parsed?.backedUp)
      ? parsed.backedUp.filter((id): id is string => typeof id === 'string').map((id) => id.toLowerCase())
      : [];
    return { records, rows, backedUp };
  } catch {
    return empty;
  }
}

/**
 * Adds `value` to what is stored for the account (the new copy of a record
 * wins). True when the store holds it afterwards; false on a quota or a
 * blocked store, which a caller about to hand out a link must treat as
 * failure.
 */
export function writeStoredStellarRequests(
  chainId: number,
  owner: string,
  value: Partial<StoredStellarRequests>,
  storage: StorageLike | null = localStore(),
  env: AppEnvironment = ACTIVE_APP_ENVIRONMENT,
): boolean {
  if (!storage) return false;
  const current = readStoredStellarRequests(chainId, owner, storage, env);
  // The newer copy of a request wins unless the stored one is further along.
  const stored = new Map(current.records.map((r) => [idOf(r), r]));
  const incoming = (value.records ?? []).map((r) => (stored.has(idOf(r)) ? furtherRequestCopy(r, stored.get(idOf(r))) : r));
  const records = union(incoming, current.records, idOf);
  const held = new Set(records.map(idOf));
  const next: StoredStellarRequests = {
    records,
    rows: union(value.rows ?? [], current.rows, (r) => r.requestId),
    backedUp: union(value.backedUp ?? [], current.backedUp, (id) => id.toLowerCase()).map((id) => id.toLowerCase()).filter((id) => held.has(id)),
  };
  return put(storage, stellarRequestStorageKey(chainId, owner, env), next);
}

function put(storage: StorageLike, key: string, next: StoredStellarRequests): boolean {
  try {
    if (next.records.length === 0 && next.rows.length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}

/**
 * Notes that the user holds a backup of these requests (only stored ones
 * count). Call it only on proof, as PR #209 defines it: the save-file picker
 * wrote and closed the file, a native share reported completion, or an
 * imported backup holds the same recovery data (markStellarRequestsHeldByBackup).
 * A plain download or a button press proves nothing.
 */
export function markStellarRequestsBackedUp(
  chainId: number,
  owner: string,
  paymentIds: readonly string[],
  storage: StorageLike | null = localStore(),
  env: AppEnvironment = ACTIVE_APP_ENVIRONMENT,
): boolean {
  return writeStoredStellarRequests(chainId, owner, { backedUp: [...paymentIds] }, storage, env);
}

/**
 * Sign-out: removes this owner's requests (in this environment only) that a
 * downloaded backup already holds, with their list rows. A request no file
 * has yet stays, since it would otherwise be lost. Nothing else in the
 * storage is touched. Returns how many records were removed.
 */
export function purgeBackedUpStellarRequests(
  chainId: number,
  owner: string,
  storage: StorageLike | null = localStore(),
  env: AppEnvironment = ACTIVE_APP_ENVIRONMENT,
): number {
  if (!storage) return 0;
  const current = readStoredStellarRequests(chainId, owner, storage, env);
  const covered = new Set(current.backedUp);
  const removed = current.records.filter((r) => covered.has(idOf(r) ?? ''));
  if (removed.length === 0) return 0;
  const removedRows = new Set(removed.map((r) => stellarBlindRequestId(idOf(r) ?? '')));
  const next: StoredStellarRequests = {
    records: current.records.filter((r) => !covered.has(idOf(r) ?? '')),
    rows: current.rows.filter((r) => !removedRows.has(r.requestId)),
    backedUp: [],
  };
  return put(storage, stellarRequestStorageKey(chainId, owner, env), next) ? removed.length : 0;
}

// Mirror of holdsSameRecoveryData in services/payment-request-signout-purge.ts
// on PR #209 (fix/purge-requests-on-signout), not on this branch yet. Unify
// the two once both PRs merge.
function secretEntries(map: unknown): string[] | null {
  let entries: unknown[];
  if (map instanceof Map) entries = [...map.entries()];
  else if (Array.isArray(map)) entries = map;
  else if (map && typeof map === 'object') entries = Object.entries(map);
  else return null;
  const pairs: string[] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') return null;
    pairs.push(`${entry[0].toLowerCase()}=${entry[1].toLowerCase()}`);
  }
  return pairs.sort();
}

/**
 * Whether a backup's copy of a request can stand in for the stored record:
 * same request, same note secrets, same stored private key if it has one. A
 * same-id entry with other recovery data is not a backup of THIS record.
 */
export function holdsSameRecoveryData(stored: unknown, backup: unknown): boolean {
  if (!stored || typeof stored !== 'object' || !backup || typeof backup !== 'object') return false;
  const a = stored as Record<string, unknown>;
  const b = backup as Record<string, unknown>;
  const same = (field: string) =>
    typeof a[field] === 'string' && typeof b[field] === 'string'
    && (a[field] as string).toLowerCase() === (b[field] as string).toLowerCase();
  if (!same('paymentId') || !same('tag') || !same('paymentPubKey')) return false;
  if (a.paymentPrivKey !== undefined && !same('paymentPrivKey')) return false;
  const sa = secretEntries(a.noteSecretsMap);
  const sb = secretEntries(b.noteSecretsMap);
  return !!sa && !!sb && sa.length > 0 && sa.join('|') === sb.join('|');
}

/**
 * Proof (c): an imported backup holds these records. Marks as backed up each
 * stored record the backup has an exact recovery copy of. Returns how many.
 */
// Check and mark run in one synchronous turn over localStorage (no await in
// between), so no other write can replace the record between them.
export function markStellarRequestsHeldByBackup(
  chainId: number,
  owner: string,
  backupRecords: readonly unknown[],
  storage: StorageLike | null = localStore(),
  env: AppEnvironment = ACTIVE_APP_ENVIRONMENT,
): number {
  const stored = new Map(readStoredStellarRequests(chainId, owner, storage, env).records.map((r) => [idOf(r), r]));
  const ids = backupRecords.flatMap((r) => {
    const id = idOf(r);
    return id && stored.has(id) && holdsSameRecoveryData(stored.get(id), r) ? [id] : [];
  });
  if (ids.length > 0) markStellarRequestsBackedUp(chainId, owner, ids, storage, env);
  return ids.length;
}
