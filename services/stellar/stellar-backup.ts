/**
 * The Stellar account backup file: the SDK's own sealed account export
 * (exportAccountSealed: scrypt + XChaCha20-Poly1305, the passphrase never
 * stored) plus this account's payment-request records, which are public
 * pay-link data with no secret in them.
 *
 * Restoring merges instead of replacing: the SDK's importAccount overwrites
 * the note store, which would drop a note this session holds that the backup
 * predates (a claimed one-time note cannot be rediscovered from chain). The
 * live session's copy of a note wins; the backup only adds notes; the sync
 * cursor rewinds to the older of the two so the next sync re-checks both.
 *
 * Pure module (no react-native, no SDK import) so it is bun-testable.
 */
import type { SessionPaymentRequest } from '@/services/session-payment-requests';

export const STELLAR_BACKUP_KIND = 'ppv2-stellar-backup';

export type SealedEnvelopeLike = { v: number; kdf: { name: string }; salt: string; ciphertext: string };

export type StellarBackupFile = {
  kind: typeof STELLAR_BACKUP_KIND;
  version: 1;
  chainId: number;
  /** The Stellar account (G...) the notes belong to. */
  owner: string;
  sealed: SealedEnvelopeLike;
  requests: SessionPaymentRequest[];
};

export function encodeStellarBackup(file: Omit<StellarBackupFile, 'kind' | 'version'>): string {
  const out: StellarBackupFile = { kind: STELLAR_BACKUP_KIND, version: 1, ...file };
  return JSON.stringify(out, null, 2);
}

export function isStellarBackupPayload(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { kind?: unknown };
    return parsed?.kind === STELLAR_BACKUP_KIND;
  } catch {
    return false;
  }
}

/** Strict parse: the file must be a Stellar backup for exactly this account and chain. */
export function decodeStellarBackup(
  raw: string,
  expected: { owner: string; chainId: number; /** Origins this app hands pay links out from. */ linkOrigins?: readonly string[] },
): StellarBackupFile {
  let parsed: Partial<StellarBackupFile>;
  try {
    parsed = JSON.parse(raw) as Partial<StellarBackupFile>;
  } catch {
    throw new Error('This is not a backup file.');
  }
  if (parsed?.kind !== STELLAR_BACKUP_KIND || parsed.version !== 1) throw new Error('This is not a Stellar backup.');
  if (parsed.chainId !== expected.chainId) throw new Error('This backup is for another network.');
  if (parsed.owner !== expected.owner) throw new Error('This backup belongs to another Stellar account.');
  const s = parsed.sealed;
  if (!s || typeof s.salt !== 'string' || typeof s.ciphertext !== 'string' || typeof s.v !== 'number' || !s.kdf) {
    throw new Error('This backup is damaged.');
  }
  const requests = sanitizeRequestRows(parsed.requests, expected);
  return { ...(parsed as StellarBackupFile), requests };
}

type RowExpectation = { owner: string; chainId: number; linkOrigins?: readonly string[] };

/** The request list rows a file may carry: this account's and chain's, known fields only. */
function sanitizeRequestRows(raw: unknown, expected: RowExpectation): SessionPaymentRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is SessionPaymentRequest =>
    !!r && typeof r === 'object'
    && typeof r.requestId === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(r.requestId)
    && r.chainId === expected.chainId
    && r.owner === expected.owner.toLowerCase()
    && typeof r.tokenAddress === 'string'
    && typeof r.amount === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(r.amount)
    && typeof r.createdAtMs === 'number' && Number.isFinite(r.createdAtMs)
    && (r.payLink === null || typeof r.payLink === 'string')
    && typeof r.signed === 'boolean')
    // Only the known fields are kept.
    .map((r) => ({
      requestId: r.requestId, chainId: r.chainId, owner: r.owner, tokenAddress: r.tokenAddress,
      amount: r.amount, createdAtMs: r.createdAtMs, signed: r.signed,
      // A link from anywhere else is dropped (the row stays): Copy link must
      // never hand out a URL this app did not make.
      payLink: r.payLink && isOwnPayLink(r.payLink, expected.linkOrigins ?? []) ? r.payLink : null,
    }));
}

const HEX = /^0x[0-9a-fA-F]+$/;
const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v);

/**
 * The SDK request records that belong to `owner`, in the shape the SDK's
 * import schema needs (one damaged record would otherwise fail the whole
 * import): hex ids and keys, at least one note slot, a known status.
 */
export function ownRequestRecords(raw: unknown, owner: string): unknown[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r) => {
    const rec = r as Record<string, unknown> | null;
    if (!rec || typeof rec !== 'object' || rec.recipientAddress !== owner) return false;
    const slots = rec.noteSecretsMap;
    const slotsOk = Array.isArray(slots)
      ? slots.length > 0 && slots.every((e) => Array.isArray(e) && e.length === 2 && isHex(e[0]) && isHex(e[1]))
      : !!slots && typeof slots === 'object' && Object.keys(slots).length > 0;
    return isHex(rec.paymentId) && isHex(rec.amount) && isHex(rec.tag) && isHex(rec.paymentPubKey) && isHex(rec.createdAt)
      && typeof rec.tokenId === 'string'
      && Array.isArray(rec.noteAddressHashes) && rec.noteAddressHashes.length > 0 && rec.noteAddressHashes.every(isHex)
      && slotsOk
      && (rec.status === 'OPEN' || rec.status === 'FULFILLED' || rec.status === 'ARCHIVED')
      && Array.isArray(rec.fulfilledByCommitments);
  });
}

const STATUS_RANK: Record<string, number> = { OPEN: 0, FULFILLED: 1, ARCHIVED: 2 };

/**
 * Of two copies of one request, the further along: a later status, then more
 * consumed slots, then more found commitments. A tie keeps `a`. A stale tab's
 * OPEN copy must never replace a FULFILLED one.
 */
export function furtherRequestCopy(a: unknown, b: unknown): unknown {
  const rank = (r: unknown) => {
    const rec = r as { status?: unknown; consumedSlots?: unknown; fulfilledByCommitments?: unknown } | null;
    return [
      STATUS_RANK[String(rec?.status)] ?? -1,
      Array.isArray(rec?.consumedSlots) ? rec.consumedSlots.length : 0,
      Array.isArray(rec?.fulfilledByCommitments) ? rec.fulfilledByCommitments.length : 0,
    ];
  };
  const [ra, rb] = [rank(a), rank(b)];
  for (let i = 0; i < ra.length; i++) {
    if (rb[i] > ra[i]) return b;
    if (rb[i] < ra[i]) return a;
  }
  return a;
}

/**
 * The payment-request backup, downloaded automatically when a request is
 * made (the EVM request backup's counterpart). Like that file it holds the
 * SDK request records as they are, note secrets included, and no password:
 * it is what restores a request this browser loses.
 */
export const STELLAR_REQUEST_BACKUP_KIND = 'ppv2-stellar-request-backup';

export type StellarRequestBackupFile = {
  kind: typeof STELLAR_REQUEST_BACKUP_KIND;
  version: 1;
  createdAt: string;
  chainId: number;
  owner: string;
  /** The SDK's payment-request records (exportAccount().paymentRequests). */
  records: unknown[];
  requests: SessionPaymentRequest[];
};

export function encodeStellarRequestBackup(
  file: Pick<StellarRequestBackupFile, 'chainId' | 'owner' | 'records' | 'requests'>,
  now: Date = new Date(),
): string {
  const out: StellarRequestBackupFile = { kind: STELLAR_REQUEST_BACKUP_KIND, version: 1, createdAt: now.toISOString(), ...file };
  return JSON.stringify(out, null, 2);
}

export function isStellarRequestBackupPayload(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { kind?: unknown } | null)?.kind === STELLAR_REQUEST_BACKUP_KIND;
  } catch {
    return false;
  }
}

/** Strict parse: the file must be a request backup for exactly this account and chain. */
export function decodeStellarRequestBackup(raw: string, expected: RowExpectation): StellarRequestBackupFile {
  let parsed: Partial<StellarRequestBackupFile>;
  try {
    parsed = JSON.parse(raw) as Partial<StellarRequestBackupFile>;
  } catch {
    throw new Error('This is not a backup file.');
  }
  if (parsed?.kind !== STELLAR_REQUEST_BACKUP_KIND || parsed.version !== 1) throw new Error('This is not a Stellar request backup.');
  if (parsed.chainId !== expected.chainId) throw new Error('This backup is for another network.');
  if (parsed.owner !== expected.owner) throw new Error('This backup belongs to another Stellar account.');
  return {
    kind: STELLAR_REQUEST_BACKUP_KIND,
    version: 1,
    createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    chainId: parsed.chainId,
    owner: parsed.owner,
    records: ownRequestRecords(parsed.records, expected.owner),
    requests: sanitizeRequestRows(parsed.requests, expected),
  };
}

type ExportLike<N> = { notes: N[]; syncCursor: string; paymentRequests?: unknown[] };

function commitmentKey(c: string): string {
  try { return BigInt(c).toString(16); } catch { return String(c).toLowerCase(); }
}

function minCursor(a: string, b: string): string {
  try { return BigInt(a) <= BigInt(b) ? a : b; } catch { return a; }
}

function paymentIdOf(r: unknown): string | null {
  const id = (r as { paymentId?: unknown } | null)?.paymentId;
  return typeof id === 'string' ? id.toLowerCase() : null;
}

/**
 * The live export, plus every note and every payment request only the backup
 * has, with the older cursor. A blind request's record is the only way its
 * payment is found, so a restore must never drop one the backup carries.
 */
export function mergeStellarExports<N extends { commitment: string }, T extends ExportLike<N>>(live: T, restored: ExportLike<N>): T {
  const have = new Set(live.notes.map((n) => commitmentKey(n.commitment)));
  const added = restored.notes.filter((n) => !have.has(commitmentKey(n.commitment)));
  const liveRequests = live.paymentRequests ?? [];
  const haveRequests = new Set(liveRequests.map(paymentIdOf).filter((id): id is string => !!id));
  const addedRequests = (restored.paymentRequests ?? []).filter((r) => {
    const id = paymentIdOf(r);
    if (!id || haveRequests.has(id)) return false;
    haveRequests.add(id);
    return true;
  });
  return {
    ...live,
    notes: [...live.notes, ...added],
    ...(liveRequests.length + addedRequests.length > 0 ? { paymentRequests: [...liveRequests, ...addedRequests] } : {}),
    syncCursor: minCursor(live.syncCursor, restored.syncCursor),
  };
}

/**
 * The live export plus the request records only `records` has. When any is
 * added the cursor rewinds to the start, so the next sync looks for payments
 * made to them while this session did not hold them. Nothing added: `live`
 * as is.
 */
export function mergeStellarRequestRecords<N extends { commitment: string }, T extends ExportLike<N>>(
  live: T,
  records: readonly unknown[],
): { merged: T; added: number } {
  const have = new Set((live.paymentRequests ?? []).map(paymentIdOf).filter((id): id is string => !!id));
  const added = new Set(records.map(paymentIdOf).filter((id): id is string => !!id && !have.has(id))).size;
  if (added === 0) return { merged: live, added: 0 };
  return { merged: mergeStellarExports<N, T>(live, { notes: [] as N[], syncCursor: '0x0', paymentRequests: [...records] }), added };
}

/** A restored pay link must be one of ours: a /pay#xlm. (or older /pay/xlm.) link on an origin this app shares from. */
function isOwnPayLink(link: string, origins: readonly string[]): boolean {
  try {
    const url = new URL(link);
    const trusted = origins.some((o) => { try { return new URL(o).origin === url.origin; } catch { return false; } });
    return trusted && (url.protocol === 'https:' || url.protocol === 'http:') && /^\/pay[/#]xlm\./.test(url.pathname + url.hash);
  } catch {
    return false;
  }
}
