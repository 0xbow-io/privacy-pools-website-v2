/**
 * WHOSE notes are in this bucket?
 *
 * The account export is stored per (address, chainId) — the storage KEY says
 * who it belongs to. Nothing said who the CONTENT came from, so a write that
 * took its notes from one session and its key from another filed account A's
 * notes under account B, where every later read was correct code returning
 * poisoned data: B's balance showed A's ETH and A's received-transfer rows,
 * while a fresh tab showed B's real $0 (Pat, 2026-08-28, after switching
 * accounts inside the wallet with no disconnect).
 *
 * `resolveNotePersistTarget` (services/note-source.ts) closed the one write
 * that did it. This closes the CLASS, at both ends of the pipe:
 *
 *   - WRITE: a blob whose envelope or owned notes name another owner is
 *     refused, not filed.
 *   - READ: a bucket whose stamp disagrees with its own key is not served.
 *
 * No new format. `AccountExport` already carries optional `owner` and
 * `chainId` (SDK PoolSessionExport.ts), which `exportAccount()` fills with the
 * producing session's identity and `assertEnvelopeMatches` already validates
 * on import. The gap is that `NoteManager.exportState()` returns only
 * `{notes, syncCursor}` and `mergeImportedNote` rebuilds the envelope from
 * scratch, so most saves lack an envelope stamp. Their notes still carry the
 * SDK-required ownerAddress, which lets the choke point reject the real
 * unstamped wallet-switch race before stamping the accepted destination.
 *
 * NO USABLE EVIDENCE IS NOT A MISMATCH. A legacy empty blob, or one with
 * malformed/missing identity fields, cannot be convicted without risking real
 * received notes that no rescan can recover. Only a present, readable and
 * disagreeing envelope/note identity is refused.
 *
 * PURE module: no concrete storage, React, or SDK dependency. Storage effects
 * are injected, so failure policy is testable on its own.
 */

export interface ExportIdentity {
  address: string;
  chainId: number;
}

/** Minimal synchronous storage surface, injected so failure policy stays pure. */
export interface StoredValueAccess {
  read: (key: string) => string | null;
  write: (key: string, value: string) => void;
}

export type ParkStoredValueResult =
  | 'parked'
  | 'parking-occupied'
  | 'parking-write-failed'
  | 'source-clear-failed';

export type ExportIdentityVerdict =
  /** The stamp names this bucket. */
  | { status: 'match' }
  /** No usable envelope or per-note identity evidence to check. */
  | { status: 'unstamped' }
  /** The stamp names someone else. The content does not belong here. */
  | {
    status: 'mismatch';
    field: 'owner' | 'note.ownerAddress' | 'chainId';
    stamped: string;
    expected: string;
  };

/** Normalise a complete EVM address for comparison; malformed reads as absent. */
function addressOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const address = value.trim();
  return /^0x[0-9a-f]{40}$/i.test(address) ? address.toLowerCase() : null;
}

/**
 * A chain id that is actually a number.
 *
 * Hand-built envelopes and JSON round-trips can carry it as a string, so it is
 * accepted in decimal/hex integer form. Other values are treated as ABSENT
 * rather than as a mismatch — an unreadable stamp is no evidence.
 */
function chainIdOf(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = typeof value === 'string' ? value.trim() : value;
  if (normalized === '') return null;
  if (typeof normalized === 'string' && !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

export function accountExportIdentityVerdict(
  blob: unknown,
  expected: ExportIdentity,
): ExportIdentityVerdict {
  if (!blob || typeof blob !== 'object') return { status: 'unstamped' };
  const stamped = blob as { owner?: unknown; chainId?: unknown; notes?: unknown };

  const stampedOwner = addressOf(stamped.owner);
  const expectedOwner = addressOf(expected.address);
  if (stampedOwner && expectedOwner && stampedOwner !== expectedOwner) {
    return { status: 'mismatch', field: 'owner', stamped: stampedOwner, expected: expectedOwner };
  }

  // NoteManager.exportState() deliberately omits the envelope stamp. That is
  // the exact shape involved in the wallet-switch race this guard exists to
  // catch, so checking only `owner` would accept A's live notes for B and then
  // bless them by stamping the destination bucket. Owned EVM notes carry the
  // same ownerAddress the SDK validates on received-note import; malformed or
  // absent values remain fail-open for genuinely legacy blobs.
  let anyNoteNamesUs = false;
  let firstForeignNoteOwner: string | null = null;
  if (Array.isArray(stamped.notes)) {
    for (const value of stamped.notes) {
      if (!value || typeof value !== 'object') continue;
      const noteOwner = addressOf((value as { ownerAddress?: unknown }).ownerAddress);
      if (!noteOwner) continue;
      if (expectedOwner && noteOwner === expectedOwner) anyNoteNamesUs = true;
      else if (firstForeignNoteOwner === null) firstForeignNoteOwner = noteOwner;
    }
  }
  // UNANIMITY IS REQUIRED to convict on note owners, and that is not caution
  // for its own sake — a MIXED bucket is what a legitimate one looks like.
  // The SDK sets a note's ownerAddress to something other than the session
  // owner in exactly one case: a stealth-delivered deposit carries its derived
  // stealth address (NoteDiscoveryService.tryDecryptStealthDepositEvent), and
  // every other scan path leaves it unset and falls back to the session owner.
  // ppv2 does not opt into that scan today (it never passes
  // stealthDepositCredentials), but convicting on a single foreign note owner
  // would mean that the day it does, one rescued dust note quarantines the
  // whole bucket and the user's entire balance disappears. Wholesale
  // poisoning — one session's export written under another's key — replaces
  // the bucket outright, so it is unanimous and still caught.
  if (expectedOwner && firstForeignNoteOwner && !anyNoteNamesUs) {
    return {
      status: 'mismatch',
      field: 'note.ownerAddress',
      stamped: firstForeignNoteOwner,
      expected: expectedOwner,
    };
  }
  const hasNoteOwnerEvidence = anyNoteNamesUs || firstForeignNoteOwner !== null;

  const stampedChain = chainIdOf(stamped.chainId);
  if (stampedChain !== null && stampedChain !== expected.chainId) {
    return {
      status: 'mismatch',
      field: 'chainId',
      stamped: String(stampedChain),
      expected: String(expected.chainId),
    };
  }

  return stampedOwner || stampedChain !== null || hasNoteOwnerEvidence
    ? { status: 'match' }
    : { status: 'unstamped' };
}

/**
 * Record which bucket this blob was written for.
 *
 * Returns a NEW object — the caller's blob is often a live manager's export
 * and must not be mutated. `notes` and `syncCursor` are carried through
 * untouched: a blob that loses either is treated by the SDK as a legacy export
 * and silently resets the manager to empty, which loses out-of-band notes no
 * rescan can recover (NoteManager.importState).
 */
export function stampAccountExport<T extends object>(blob: T, identity: ExportIdentity): T {
  return { ...blob, owner: identity.address, chainId: identity.chainId };
}

/** A swallowed quota/SecureStore error is still a failed write after read-back. */
export function writeStoredValueVerified(
  access: StoredValueAccess,
  key: string,
  value: string,
): boolean {
  try {
    access.write(key, value);
    return access.read(key) === value;
  } catch {
    return false;
  }
}

/**
 * Preserve a refused value without ever deleting the only copy.
 *
 * The destination is write-and-read verified before the source is cleared.
 * Clearing uses an empty value rather than an async remove: expo-secure-store's
 * delete API can otherwise race a subsequent save to the same primary key.
 * An occupied parking slot is never overwritten, because it may itself contain
 * the only copy of out-of-band notes from an earlier incident.
 */
export function parkStoredValue(
  access: StoredValueAccess,
  sourceKey: string,
  parkingKey: string,
  raw: string,
): ParkStoredValueResult {
  let parkedRaw: string | null;
  try {
    parkedRaw = access.read(parkingKey);
  } catch {
    return 'parking-write-failed';
  }
  if (parkedRaw && parkedRaw !== raw) return 'parking-occupied';
  if (parkedRaw !== raw && !writeStoredValueVerified(access, parkingKey, raw)) {
    return 'parking-write-failed';
  }
  if (!writeStoredValueVerified(access, sourceKey, '')) return 'source-clear-failed';
  return 'parked';
}
