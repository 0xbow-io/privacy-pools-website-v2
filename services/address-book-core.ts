// Pure half of services/address-book-store.ts: the local contact list that
// names recipient addresses, plus its import/export file format.
//
// What a contact holds, on purpose: an address, the name the user gave it, and
// the DAY that name was first set and last changed. Nothing else. No chain, no
// tx hash, no amount, no "last paid" time, nothing derived from a note. The
// payout records the dropdown reads (services/recipient-suggestions.ts) stay in
// their own stores and are never copied in here, so a contact list (or an
// exported file) says "I know this address", not "this note left to it at that
// moment". The timestamps are rounded to the UTC day for the same reason: a
// name set right after a payout must not carry that payout's minute.
//
// No react-native import: bun-testable.

import { getAddress } from 'viem';

export type AddressFormat = 'evm' | 'sui' | 'stellar';

export type Contact = {
  /** Display form: checksummed for EVM, lowercase for Sui, as-is for Stellar. */
  address: string;
  name: string;
  /** unix ms, rounded down to the UTC day */
  createdAt: number;
  /** unix ms, rounded down to the UTC day */
  updatedAt: number;
};

export const CONTACTS_FILE_TYPE = 'privacy-pools-contacts';
export const CONTACTS_FILE_VERSION = 1;
/** Bounded so storage (SecureStore on native) and the dropdown stay small. */
export const MAX_CONTACTS = 500;
export const MAX_CONTACT_NAME_LENGTH = 40;
/** A contacts file is a few KB; anything far bigger is not one. */
export const MAX_IMPORT_BYTES = 256 * 1024;

const DAY_MS = 86_400_000;
const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SUI_RE = /^0x[0-9a-fA-F]{64}$/;
const STELLAR_RE = /^G[A-Z2-7]{55}$/;

export function roundToDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function addressFormatOf(raw: string | null | undefined): AddressFormat | null {
  const v = (raw ?? '').trim();
  if (EVM_RE.test(v)) return 'evm';
  if (SUI_RE.test(v)) return 'sui';
  if (STELLAR_RE.test(v)) return 'stellar';
  return null;
}

export type CanonicalAddress = { format: AddressFormat; key: string; display: string };

/**
 * Identity of an address for dedupe. Hex formats (EVM, Sui) compare
 * case-insensitively, since case carries no meaning there (EVM case is only a
 * checksum); a Stellar strkey compares exactly.
 */
export function canonicalAddress(raw: string | null | undefined): CanonicalAddress | null {
  const v = (raw ?? '').trim();
  const format = addressFormatOf(v);
  if (!format) return null;
  if (format === 'stellar') return { format, key: v, display: v };
  const lower = v.toLowerCase();
  if (format === 'sui') return { format, key: lower, display: lower };
  let display = lower;
  try { display = getAddress(lower); } catch { /* keep lowercase */ }
  return { format, key: lower, display };
}

/** 0x1234…abcd / GABC…WXYZ */
export function shortAddress(address: string): string {
  if (address.length <= 14) return address;
  return address.startsWith('0x') ? `${address.slice(0, 6)}…${address.slice(-4)}` : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/** Trim, drop control characters, collapse whitespace, cap the length. Empty means "no name". */
export function cleanContactName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, MAX_CONTACT_NAME_LENGTH).join('').trim();
}

function toDay(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return roundToDay(raw);
  if (typeof raw === 'string' && raw) {
    const t = Date.parse(raw);
    if (Number.isFinite(t) && t > 0) return roundToDay(t);
  }
  return roundToDay(fallback);
}

/**
 * A stored or imported row, reduced to the four known fields. Anything else
 * on the row (a chain, a tx hash, a note field) does not survive.
 */
export function normalizeContact(raw: unknown, now: number): Contact | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const canon = canonicalAddress(typeof r.address === 'string' ? r.address : null);
  const name = cleanContactName(r.name);
  if (!canon || !name) return null;
  const createdAt = toDay(r.createdAt, now);
  const updatedAt = Math.max(createdAt, toDay(r.updatedAt, createdAt));
  return { address: canon.display, name, createdAt, updatedAt };
}

/** Stored list: valid rows only, one per address (newest edit wins), bounded. */
export function parseContacts(raw: unknown, now = Date.now()): Contact[] {
  if (!Array.isArray(raw)) return [];
  const byKey = new Map<string, Contact>();
  for (const row of raw) {
    const c = normalizeContact(row, now);
    if (!c) continue;
    const key = canonicalAddress(c.address)!.key;
    const prev = byKey.get(key);
    if (!prev || c.updatedAt >= prev.updatedAt) byKey.set(key, c);
  }
  return sortContacts(Array.from(byKey.values())).slice(0, MAX_CONTACTS);
}

/** Alphabetical by name, then address: a stable order for the settings list and the file. */
export function sortContacts(list: readonly Contact[]): Contact[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.address.localeCompare(b.address));
}

export function contactIndex(list: readonly Contact[]): Map<string, Contact> {
  const m = new Map<string, Contact>();
  for (const c of list) {
    const canon = canonicalAddress(c.address);
    if (canon) m.set(canon.key, c);
  }
  return m;
}

export type SetNameResult = { list: Contact[]; error: string | null };

/**
 * Set, rename or clear (empty name) one contact. A new contact past the bound
 * is refused with a message rather than silently dropping an old one.
 */
export function setContactName(list: readonly Contact[], address: string, rawName: string, now: number): SetNameResult {
  const canon = canonicalAddress(address);
  if (!canon) return { list: [...list], error: 'Not a valid address.' };
  const name = cleanContactName(rawName);
  const day = roundToDay(now);
  const rest = list.filter((c) => canonicalAddress(c.address)?.key !== canon.key);
  if (!name) return { list: rest, error: null };
  const prev = list.find((c) => canonicalAddress(c.address)?.key === canon.key);
  if (!prev && rest.length >= MAX_CONTACTS) return { list: [...list], error: `Contact list is full (${MAX_CONTACTS}).` };
  if (prev && prev.name === name) return { list: [...list], error: null };
  const next: Contact = { address: canon.display, name, createdAt: prev?.createdAt ?? day, updatedAt: day };
  return { list: sortContacts([...rest, next]), error: null };
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

export type ContactsFile = {
  type: typeof CONTACTS_FILE_TYPE;
  version: typeof CONTACTS_FILE_VERSION;
  contacts: Contact[];
};

/** The whole file. Only the four contact fields, nothing about the account. */
export function buildContactsExport(list: readonly Contact[]): string {
  const file: ContactsFile = {
    type: CONTACTS_FILE_TYPE,
    version: CONTACTS_FILE_VERSION,
    contacts: sortContacts(list).map(({ address, name, createdAt, updatedAt }) => ({ address, name, createdAt, updatedAt })),
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export const CONTACTS_EXPORT_FILENAME = 'privacy-pools-contacts.json';

export type ParsedImport =
  | { ok: true; contacts: Contact[]; invalid: number }
  | { ok: false; error: string };

function byteLength(text: string): number {
  // Close enough without TextEncoder: UTF-16 units over-count nothing that matters here.
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : (c >= 0xd800 && c <= 0xdbff) ? 2 : 3;
  }
  return n;
}

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

function rowsFromCsv(text: string): unknown[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const hasHeader = header.includes('address');
  const addrCol = hasHeader ? header.indexOf('address') : 0;
  const nameCol = hasHeader ? (header.includes('name') ? header.indexOf('name') : -1) : 1;
  return (hasHeader ? rows.slice(1) : rows).map((r) => ({
    address: (r[addrCol] ?? '').trim(),
    name: nameCol >= 0 ? r[nameCol] ?? '' : '',
  }));
}

/**
 * Read a contacts file (our JSON, a bare JSON array, or CSV with
 * address,name columns). Bad rows are counted, not fatal; a file that is not a
 * contacts file at all is one plain error.
 */
export function parseContactsImport(text: string, now = Date.now()): ParsedImport {
  if (byteLength(text) > MAX_IMPORT_BYTES) return { ok: false, error: 'This file is too large. Contacts files are under 256 KB.' };
  const trimmed = text.replace(/^﻿/, '').trim();
  if (!trimmed) return { ok: false, error: 'This file is empty.' };
  let rows: unknown[];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { return { ok: false, error: 'This file could not be read. Pick a contacts file exported from Privacy Pools, or a CSV.' }; }
    if (Array.isArray(parsed)) rows = parsed;
    else if (parsed && typeof parsed === 'object') {
      const f = parsed as Record<string, unknown>;
      if (f.type !== CONTACTS_FILE_TYPE || !Array.isArray(f.contacts)) return { ok: false, error: 'This is not a contacts file.' };
      if (typeof f.version !== 'number' || f.version > CONTACTS_FILE_VERSION) return { ok: false, error: 'This file comes from a newer version of the app. Update and try again.' };
      rows = f.contacts;
    } else return { ok: false, error: 'This is not a contacts file.' };
  } else {
    rows = rowsFromCsv(trimmed);
  }
  if (rows.length === 0) return { ok: false, error: 'No contacts in this file.' };
  const seen = new Set<string>();
  const contacts: Contact[] = [];
  let invalid = 0;
  for (const row of rows) {
    const c = normalizeContact(row, now);
    if (!c) { invalid++; continue; }
    const key = canonicalAddress(c.address)!.key;
    if (seen.has(key)) { invalid++; continue; }
    seen.add(key);
    contacts.push(c);
  }
  if (contacts.length === 0) return { ok: false, error: 'No valid contacts in this file.' };
  return { ok: true, contacts, invalid };
}

export type ImportPlan = {
  /** Not in the list yet. */
  added: Contact[];
  /** Saved under a different name; `incoming` is the file's. */
  conflicts: { existing: Contact; incoming: Contact }[];
  /** Already saved under the same name. */
  unchanged: number;
};

export function planContactsImport(existing: readonly Contact[], incoming: readonly Contact[]): ImportPlan {
  const index = contactIndex(existing);
  const plan: ImportPlan = { added: [], conflicts: [], unchanged: 0 };
  for (const c of incoming) {
    const prev = index.get(canonicalAddress(c.address)!.key);
    if (!prev) plan.added.push(c);
    else if (prev.name === c.name) plan.unchanged++;
    else plan.conflicts.push({ existing: prev, incoming: c });
  }
  return plan;
}

export type ImportResult = { list: Contact[]; added: number; renamed: number; skipped: number };

/**
 * Apply a plan. The merge rule: an import never changes a name you already
 * saved unless `replaceNames` is set (the UI asks first). New addresses past
 * the list bound are skipped and counted.
 */
export function applyContactsImport(
  existing: readonly Contact[],
  plan: ImportPlan,
  opts: { replaceNames: boolean; invalid: number; now: number },
): ImportResult {
  const day = roundToDay(opts.now);
  const index = contactIndex(existing);
  let renamed = 0;
  if (opts.replaceNames) {
    for (const { existing: prev, incoming } of plan.conflicts) {
      index.set(canonicalAddress(prev.address)!.key, { ...prev, name: incoming.name, updatedAt: day });
      renamed++;
    }
  }
  let added = 0;
  let overLimit = 0;
  for (const c of plan.added) {
    if (index.size >= MAX_CONTACTS) { overLimit++; continue; }
    index.set(canonicalAddress(c.address)!.key, c);
    added++;
  }
  const skipped = plan.unchanged + (opts.replaceNames ? 0 : plan.conflicts.length) + overLimit + opts.invalid;
  return { list: sortContacts(Array.from(index.values())), added, renamed, skipped };
}

/** "12 added, 3 skipped" */
export function importSummary(r: Pick<ImportResult, 'added' | 'renamed' | 'skipped'>): string {
  const parts = [`${r.added} added`];
  if (r.renamed > 0) parts.push(`${r.renamed} renamed`);
  if (r.skipped > 0) parts.push(`${r.skipped} skipped`);
  return parts.join(', ');
}
