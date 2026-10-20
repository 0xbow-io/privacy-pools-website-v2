import { Platform } from 'react-native';
import { envScopedStorageKey } from '@/config/app-environment';
import { sessionRequestKey } from '@/services/session-payment-request-backup';

/**
 * Registered requests are listed in session storage. Export includes these
 * records so users can preserve their links and restore the list in a new
 * session or on another device. Receiving payments still depends only on keys.
 */
export type SessionPaymentRequest = {
  requestId: string;
  chainId: number;
  /** Lowercased owner (recipient) the request belongs to. */
  owner: string;
  tokenAddress: string;
  /** Hex amount, exactly as encoded in the payload. */
  amount: string;
  createdAtMs: number;
  /** The full shareable /pay link, rebuilt-free (captured at creation). */
  payLink: string | null;
  signed: boolean;
};

// Environment-scoped (config/app-environment.ts): prod and staging deploy on the
// same chain ids, so a chain-keyed record must not cross between worlds.
const KEY = envScopedStorageKey('ppv2_session_payment_requests_v1');

// Native has no sessionStorage; an in-memory list gives the same semantics
// (dies with the app process).
let memory: SessionPaymentRequest[] = [];
let memoryOnly = false;

function read(): SessionPaymentRequest[] {
  if (!memoryOnly && Platform.OS === 'web' && typeof sessionStorage !== 'undefined') {
    try {
      const raw = sessionStorage.getItem(KEY);
      const records = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(records)) throw new Error('Invalid session request store');
      memory = records;
      return memory;
    } catch {
      memoryOnly = true;
    }
  }
  return memory;
}

function write(records: SessionPaymentRequest[]): void {
  if (!memoryOnly && Platform.OS === 'web' && typeof sessionStorage !== 'undefined') {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(records));
      memory = records;
      return;
    } catch {
      // Keep reads on the same fallback after a quota/private-mode failure.
      memoryOnly = true;
    }
  }
  memory = records;
}

export function addSessionPaymentRequest(record: SessionPaymentRequest): void {
  const rest = read().filter((entry) => sessionRequestKey(entry) !== sessionRequestKey(record));
  write([{ ...record, owner: record.owner.toLowerCase() }, ...rest]);
}

export function listSessionPaymentRequests(owner: string): SessionPaymentRequest[] {
  const target = owner.toLowerCase();
  return read().filter((entry) => entry.owner === target);
}

/** Local records win on duplicate imports, preserving their original dates. */
export function importSessionPaymentRequests(records: SessionPaymentRequest[]): { restored: number; skipped: number } {
  const current = read();
  const keys = new Set(current.map(sessionRequestKey));
  const added: SessionPaymentRequest[] = [];
  for (const record of records) {
    const key = sessionRequestKey(record);
    if (keys.has(key)) continue;
    keys.add(key);
    added.push(record);
  }
  if (added.length) write([...added, ...current]);
  return { restored: added.length, skipped: records.length - added.length };
}
