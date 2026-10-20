import { MAX_CLAIM_RECORDS, normalizeClaimCommitment, parseClaimRecords, type ClaimRecord } from './claim-records-core';

type ClaimStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

const recordKey = (prefix: string, record: ClaimRecord) => `${prefix}.${record.chainId}.${normalizeClaimCommitment(record.commitment)}`;

/** Each commitment has its own key: two tabs claiming different notes cannot
 *  overwrite each other's list. The old array remains readable for migration. */
export function readWebClaimRecords(storage: ClaimStorage, prefix: string): ClaimRecord[] {
  const records = new Map<string, ClaimRecord>();
  const read = (key: string) => {
    try {
      for (const r of parseClaimRecords(JSON.parse(storage.getItem(key) ?? 'null'))) {
        const k = recordKey(prefix, r);
        if (!records.has(k) || records.get(k)!.timestamp <= r.timestamp) records.set(k, r);
      }
    } catch { /* One malformed entry must not hide the other claims. */ }
  };
  read(prefix);
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(`${prefix}.`)) read(key);
  }
  return [...records.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** Move the old single-array entry to per-record keys so pruning covers it. */
function migrateLegacyClaimRecords(storage: ClaimStorage, prefix: string): void {
  const raw = storage.getItem(prefix);
  if (raw === null) return;
  let legacy: ClaimRecord[] = [];
  try { legacy = parseClaimRecords(JSON.parse(raw)); } catch { /* Malformed legacy entry: drop it. */ }
  for (const record of legacy) {
    const key = recordKey(prefix, record);
    let current: ClaimRecord | undefined;
    try { current = parseClaimRecords(JSON.parse(storage.getItem(key) ?? 'null'))[0]; } catch { /* Overwrite a malformed entry. */ }
    if (!current || current.timestamp < record.timestamp) storage.setItem(key, JSON.stringify([record]));
  }
  storage.removeItem(prefix);
}

export function writeWebClaimRecords(storage: ClaimStorage, prefix: string, records: readonly ClaimRecord[]): void {
  migrateLegacyClaimRecords(storage, prefix);
  for (const record of records) storage.setItem(recordKey(prefix, record), JSON.stringify([record]));
  const all = readWebClaimRecords(storage, prefix);
  for (const old of all.slice(0, Math.max(0, all.length - MAX_CLAIM_RECORDS))) {
    const key = recordKey(prefix, old);
    // A second tab may have refreshed this entry since the pruning snapshot.
    if (storage.getItem(key) === JSON.stringify([old])) storage.removeItem(key);
  }
}
