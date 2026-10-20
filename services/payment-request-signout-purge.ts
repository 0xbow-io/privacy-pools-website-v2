// Sign-out purge of one owner's stored payment-request records. PURE (no
// react-native import) so bun tests exercise the exact logic the app runs.
//
// The stored record (`v1:payment-request-state:<chainId>:<owner>`) carries the
// request's note secrets, and its key names the owner in plaintext. It used to
// outlive every sign-out. Purging it is only safe for a record the user holds
// a backup of: for an unregistered request the record is the only thing that
// finds the payment, so a purged record with no backup is a lost payment.
//
// So a record is purged only when it is COVERED: its paymentId is in this
// owner's backup ledger, which is written only on PROOF that the user holds a
// backup of it: a save the browser confirmed written (the File System Access
// picker), an iOS share the platform reports completed, or an import from a
// backup. A plain anchor download is NOT proof (Chrome drops a gesture-less
// one silently, and a "where to save" prompt can be cancelled), so it covers
// nothing. An uncovered record is KEPT: sign-out never deletes the only copy.

import { type AppEnvironment, envScopedStorageKey } from '@/config/app-environment';
import { PAYMENT_REQUEST_KEY_BASE } from '@/services/payment-request-store-read';

/** The async key/value surface of services/sdk-storage's IStorageService. */
export type PurgeStorage = {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
};

export const PAYMENT_REQUEST_BACKUP_LEDGER_BASE = 'ppv2_payment_request_backups_v1';

/** Logical key of an owner's ledger of backed-up paymentIds (env-scoped by the storage layer). */
export function paymentRequestBackupLedgerKey(owner: string): string {
  return `${PAYMENT_REQUEST_BACKUP_LEDGER_BASE}:${owner.toLowerCase()}`;
}

const OWNER_RECORD_KEY = new RegExp(`^${PAYMENT_REQUEST_KEY_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):(0x[0-9a-fA-F]{40})$`);

/** The chain id of a logical record key that belongs to `owner`, else null. */
export function ownerRecordKeyChainId(logicalKey: string, owner: string): number | null {
  const match = OWNER_RECORD_KEY.exec(logicalKey);
  if (!match || match[2].toLowerCase() !== owner.toLowerCase()) return null;
  return Number(match[1]);
}

/**
 * The logical record keys of `owner` among raw localStorage keys, for `env`
 * only (prod keys carry an env suffix, staging keys are bare). Other owners'
 * keys, the other environment's keys and unrelated keys are never returned.
 */
export function ownerRecordKeysFromPhysical(
  physicalKeys: readonly string[],
  owner: string,
  env: AppEnvironment,
): string[] {
  const prodSuffix = envScopedStorageKey('', 'prod');
  const keys: string[] = [];
  for (const physical of physicalKeys) {
    const isProdKey = physical.endsWith(prodSuffix);
    if ((env === 'prod') !== isProdKey) continue;
    const logical = isProdKey ? physical.slice(0, -prodSuffix.length) : physical;
    if (ownerRecordKeyChainId(logical, owner) !== null) keys.push(logical);
  }
  return keys;
}

/** The owner a logical record key belongs to (lowercase), else null. */
export function recordKeyOwner(logicalKey: string): string | null {
  const match = OWNER_RECORD_KEY.exec(logicalKey);
  return match ? match[2].toLowerCase() : null;
}

/**
 * Which owner, if any, an identity change signs out. `prev` is the last
 * session owner, `next` the current one (null when there is none) and
 * `accountStatus` wagmi's. A switch to another owner signs `prev` out at once
 * (wallet account switch, key sign-in over a wallet, key sign-out onto a
 * connected wallet). An empty identity signs out only once wagmi has settled
 * on 'disconnected': a 'connecting'/'reconnecting' blip is not a sign-out.
 */
export function signedOutOwner(
  prev: string | null,
  next: string | null,
  accountStatus: string | undefined,
): { signedOut: string | null; owner: string | null } {
  const prevOwner = prev?.toLowerCase() ?? null;
  const nextOwner = next?.toLowerCase() ?? null;
  if (nextOwner) {
    return { signedOut: prevOwner && prevOwner !== nextOwner ? prevOwner : null, owner: nextOwner };
  }
  if (prevOwner && accountStatus === 'disconnected') return { signedOut: prevOwner, owner: null };
  return { signedOut: null, owner: prevOwner };
}

// ---------------------------------------------------------------------------
// Write block: a torn-down session can still finish an in-flight save (a
// discovery pass marking a request fulfilled) after the purge, which would put
// the secrets straight back. Writes to a signed-out owner's record keys are
// refused until that owner is the session identity again.
// ---------------------------------------------------------------------------

const blockedOwners = new Set<string>();

export function blockPaymentRequestWrites(owner: string): void {
  blockedOwners.add(owner.toLowerCase());
}

export function allowPaymentRequestWrites(owner: string): void {
  blockedOwners.delete(owner.toLowerCase());
}

/** Throws when `logicalKey` is a record key of a signed-out owner. */
export function assertPaymentRequestWriteAllowed(logicalKey: string): void {
  if (blockedOwners.size === 0) return;
  const owner = recordKeyOwner(logicalKey);
  if (owner && blockedOwners.has(owner)) {
    throw new Error('Payment-request store write refused: that account is signed out.');
  }
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

async function readLedger(storage: PurgeStorage, owner: string): Promise<Set<string>> {
  try {
    const raw = await storage.get<unknown>(paymentRequestBackupLedgerKey(owner));
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((id): id is string => typeof id === 'string').map((id) => id.toLowerCase()));
  } catch {
    return new Set();
  }
}

// Read-modify-write of one owner's ledger is serialized, so two deliveries
// landing together cannot drop each other's ids.
const ledgerQueues = new Map<string, Promise<unknown>>();
function serializedForOwner<T>(owner: string, task: () => Promise<T>): Promise<T> {
  const key = owner.toLowerCase();
  const run = (ledgerQueues.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
  ledgerQueues.set(key, run);
  void run.finally(() => { if (ledgerQueues.get(key) === run) ledgerQueues.delete(key); }).catch(() => undefined);
  return run;
}

/** Record that a backup holding these paymentIds is in the user's hands. */
export function markPaymentRequestsBackedUp(
  storage: PurgeStorage,
  owner: string,
  paymentIds: readonly string[],
): Promise<void> {
  if (!owner || paymentIds.length === 0) return Promise.resolve();
  return serializedForOwner(owner, async () => {
    const ledger = await readLedger(storage, owner);
    const before = ledger.size;
    for (const id of paymentIds) ledger.add(id.toLowerCase());
    if (ledger.size === before) return;
    await storage.set(paymentRequestBackupLedgerKey(owner), [...ledger]);
  });
}

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
 * same request, same note secrets, same stored private key (a legacy record's
 * random key cannot be re-derived). A same-id entry with different recovery
 * data is not a backup of THIS record, so it must not let sign-out purge it.
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
 * Ledger the records inside a delivered backup's serialized text for `owner`
 * (the account it was exported for). `parse` is the Map-aware JSON parser the
 * backup was written with.
 */
export function ledgerDeliveredBackup(
  storage: PurgeStorage,
  owner: string,
  backupText: string,
  parse: (text: string) => unknown,
): Promise<void> {
  return markPaymentRequestsBackedUp(storage, owner, paymentIdsInBackup(parse(backupText)));
}

/**
 * The paymentIds inside a payment-request backup envelope (the parsed form of
 * what serializePaymentRequestBackup writes). Anything else yields none, so a
 * stray payload never marks a record as backed up.
 */
export function paymentIdsInBackup(backup: unknown): string[] {
  if (!backup || typeof backup !== 'object') return [];
  const envelope = backup as { kind?: unknown; chains?: unknown };
  if (envelope.kind !== 'ppv2-payment-request-backup' || !envelope.chains || typeof envelope.chains !== 'object') return [];
  const ids: string[] = [];
  for (const state of Object.values(envelope.chains as Record<string, unknown>)) {
    const requests = (state as { requests?: unknown } | null)?.requests;
    if (!Array.isArray(requests)) continue;
    for (const record of requests) {
      const id = (record as { paymentId?: unknown } | null)?.paymentId;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Purge
// ---------------------------------------------------------------------------

function recordId(record: unknown): string | null {
  const id = (record as { paymentId?: unknown } | null)?.paymentId;
  return typeof id === 'string' ? id.toLowerCase() : null;
}

export type PurgeResult = {
  /** Records removed from storage. */
  purged: number;
  /** Records kept because no backup of them is known to exist (or unreadable). */
  kept: number;
  /** True when the owner signed back in mid-purge and the purge stopped. */
  aborted: boolean;
};

/**
 * Remove `owner`'s covered payment-request records under `logicalKeys` (keys
 * of other owners are ignored). Uncovered records stay, byte for byte apart
 * from their blob losing the covered siblings; a blob that cannot be read is
 * left exactly as it is, and then so is the ledger.
 *
 * Runs only while `owner` is write-blocked (the caller blocks first). If the
 * owner signs back in meanwhile, the block lifts and the purge stops before
 * its next mutation: its snapshot predates whatever the new session writes.
 */
export function purgeOwnerPaymentRequests(
  storage: PurgeStorage,
  owner: string,
  logicalKeys: readonly string[],
): Promise<PurgeResult> {
  return serializedForOwner(owner, () => purgeLocked(storage, owner, logicalKeys));
}

async function purgeLocked(
  storage: PurgeStorage,
  owner: string,
  logicalKeys: readonly string[],
): Promise<PurgeResult> {
  const stillSignedOut = () => blockedOwners.has(owner.toLowerCase());
  const ledger = await readLedger(storage, owner);
  let purged = 0;
  let kept = 0;
  let unreadable = 0;
  for (const key of new Set(logicalKeys)) {
    if (ownerRecordKeyChainId(key, owner) === null) continue;
    let raw: unknown;
    try {
      raw = await storage.get<unknown>(key);
    } catch {
      unreadable += 1;
      continue;
    }
    if (raw == null) continue;
    const requests = (raw as { requests?: unknown }).requests;
    if (typeof raw !== 'object' || !Array.isArray(requests)) {
      unreadable += 1;
      continue;
    }
    const remaining = requests.filter((record) => {
      const id = recordId(record);
      return id === null || !ledger.has(id);
    });
    if (remaining.length === requests.length) {
      kept += remaining.length;
      continue;
    }
    // Checked right before the mutation, which itself runs synchronously on
    // web: nothing a returning session writes can land in between.
    if (!stillSignedOut()) return { purged, kept, aborted: true };
    if (remaining.length === 0) await storage.delete(key);
    else await storage.set(key, { ...(raw as Record<string, unknown>), requests: remaining });
    purged += requests.length - remaining.length;
    kept += remaining.length;
  }
  // The ledger only ever names records that were covered, and those are gone,
  // so it protects nothing now. Drop it: its key names the owner just like
  // the records' keys did. Unless a blob could not be read: its records may
  // be in the ledger, and a later sign-out needs that to purge them.
  if (unreadable === 0 && stillSignedOut()) {
    await storage.delete(paymentRequestBackupLedgerKey(owner));
  }
  return { purged, kept: kept + unreadable, aborted: false };
}
