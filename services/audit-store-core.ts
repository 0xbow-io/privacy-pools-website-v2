// Pure half of services/audit-store.ts: parsing and merging, no storage and
// no React Native imports, so the rules below can actually be tested (the
// store itself pulls in Platform and SecureStore and will not load under bun).
//
// Same split as services/outgoing-deposits-core.ts and its store.
import type { SentNoteDisclosure } from '@/services/audit-receipt';

/**
 * What the store holds, and whether we actually know.
 *
 * `ok: false` means the value could not be READ - unparseable JSON, or
 * something that is not an array. It does NOT mean empty, and keeping those
 * two apart is the entire reason this module exists.
 */
export type StoredAuditsResult =
  | { ok: true; list: SentNoteDisclosure[] }
  | { ok: false; list: [] };

/**
 * Classify a raw stored value.
 *
 * A key that was never written is genuinely empty and reading it SUCCEEDS;
 * anything present but unreadable fails. The caller must not write over a
 * failure - see `mergeSentAudits`.
 */
export function parseStoredAudits(raw: string | null | undefined): StoredAuditsResult {
  if (raw === null || raw === undefined || raw === '') return { ok: true, list: [] };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return { ok: false, list: [] };
    return { ok: true, list: parsed as SentNoteDisclosure[] };
  } catch {
    return { ok: false, list: [] };
  }
}

/**
 * Read through an accessor that may THROW (a locked-down localStorage, a
 * SecureStore without a keychain) and classify the result. The throw is a
 * failed read, never an empty store: the store used to swallow it into `null`,
 * which parses as "never written", so a throwing accessor made every
 * read-modify-write see `[]` and write `[]` back - erasing every disclosure
 * held (codex third pass, 2026-09-16).
 */
export function readStoredAudits(read: () => string | null | undefined): StoredAuditsResult {
  let raw: string | null | undefined;
  try {
    raw = read();
  } catch {
    return { ok: false, list: [] };
  }
  return parseStoredAudits(raw);
}

/**
 * The set to store after recording `list`, replacing that tx's whole set.
 *
 * Takes the ALREADY-READ current set, so the caller has to have decided what
 * to do about an unreadable store before it gets here.
 */
export function mergeSentAudits(
  current: readonly SentNoteDisclosure[],
  list: readonly SentNoteDisclosure[],
): SentNoteDisclosure[] {
  if (list.length === 0) return [...current];
  const txHash = String(list[0].txHash).toLowerCase();
  const kept = current.filter((x) => String(x.txHash).toLowerCase() !== txHash);
  for (const d of list) {
    kept.push({ ...d, txHash: String(d.txHash).toLowerCase() as SentNoteDisclosure['txHash'] });
  }
  return kept;
}

/**
 * The provisional key an out-of-band transfer stores its recipient
 * disclosures under BEFORE broadcast, when no tx hash exists yet (DEV-413).
 *
 * The change note's commitment when there is one: that note is the sender's
 * own, so once sync finds it the history row carries it under the real tx
 * hash and can look the record up (see `sentAuditsForRow`). A send with no
 * change falls back to its first recipient note, which the row finds through
 * the public snapshot's output commitments for its tx.
 */
export function transferPendingAuditKey(
  changeCommitment: string | null | undefined,
  recipientCommitments: readonly string[],
): string | null {
  const anchor = changeCommitment || recipientCommitments[0];
  return anchor ? `pending:${String(anchor).toLowerCase()}` : null;
}

/**
 * The disclosures behind one history row: the ones stored under its tx hash,
 * else a provisional set stored under one of the row's own notes, which is
 * what an unknown relay outcome leaves (the hash was never learned in the
 * modal). Returned with the row's real hash so the rebuilt link names it.
 */
export function sentAuditsForRow(
  txHash: string | null | undefined,
  rowNoteCommitments: readonly string[],
  find: (key: string) => SentNoteDisclosure[],
): SentNoteDisclosure[] {
  if (!txHash) return [];
  const byHash = find(txHash);
  if (byHash.length > 0) return byHash;
  for (const c of rowNoteCommitments) {
    const key = transferPendingAuditKey(c, []);
    if (!key) continue;
    const pending = find(key);
    if (pending.length > 0) {
      return pending.map((d) => ({ ...d, txHash: txHash.toLowerCase() as SentNoteDisclosure['txHash'] }));
    }
  }
  return [];
}
