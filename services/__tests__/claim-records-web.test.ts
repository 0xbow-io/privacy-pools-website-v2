import { expect, test } from 'bun:test';
import { MAX_CLAIM_RECORDS, toClaimedInputMap, upsertClaimRecords } from '../claim-records-core';
import { readWebClaimRecords, writeWebClaimRecords } from '../claim-records-web';

const prefix = 'test_claims';
const records = (commitments: string[], now = 1, withRegistration = true) =>
  upsertClaimRecords([], { chainId: 11155111, commitments, withRegistration, now });

function memoryStorage() {
  const entries = new Map<string, string>();
  return {
    get length() { return entries.size; },
    key: (i: number) => [...entries.keys()][i] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
}

test('interleaved claims from two tabs preserve both payments and registration flags', () => {
  const storage = memoryStorage();
  const setItem = storage.setItem;
  let interleaved = false;
  storage.setItem = (key, value) => {
    if (!interleaved) {
      interleaved = true;
      writeWebClaimRecords(storage, prefix, records(['0x03'], 2, false));
    }
    setItem(key, value);
  };
  writeWebClaimRecords(storage, prefix, records(['0x01', '0x02']));
  const claims = readWebClaimRecords(storage, prefix);
  expect(claims).toHaveLength(3);
  expect([...toClaimedInputMap(claims).values()]).toEqual([
    { withRegistration: true }, { withRegistration: true }, { withRegistration: false },
  ]);
});

test('legacy arrays survive migration and per-note updates win without duplicates', () => {
  const storage = memoryStorage();
  storage.setItem(prefix, JSON.stringify(records(['0x01', '0x02'], 1, false)));
  storage.setItem(`${prefix}.broken`, '{');
  storage.setItem('other_environment', JSON.stringify(records(['0x03'])));
  writeWebClaimRecords(storage, prefix, records(['0x01'], 2, true));
  const claims = readWebClaimRecords(storage, prefix);
  expect(claims).toHaveLength(2);
  expect(claims.map((r) => r.withRegistration)).toEqual([false, true]);
});

test('per-note storage stays bounded and retains the latest claims', () => {
  const storage = memoryStorage();
  for (let i = 1; i <= MAX_CLAIM_RECORDS + 2; i++) {
    writeWebClaimRecords(storage, prefix, records([String(i)], i));
  }
  const claims = readWebClaimRecords(storage, prefix);
  expect(claims).toHaveLength(MAX_CLAIM_RECORDS);
  expect(storage.length).toBe(MAX_CLAIM_RECORDS);
  expect(claims[0].timestamp).toBe(3);
});

test('a full legacy array is migrated and pruned with the per-note keys', () => {
  const storage = memoryStorage();
  storage.setItem(prefix, JSON.stringify(records(Array.from({ length: MAX_CLAIM_RECORDS }, (_, i) => `0x${(i + 1).toString(16)}`), 1)));
  writeWebClaimRecords(storage, prefix, records(['0xffff'], 2));
  expect(storage.getItem(prefix)).toBeNull();
  expect(storage.length).toBe(MAX_CLAIM_RECORDS);
  const claims = readWebClaimRecords(storage, prefix);
  expect(claims).toHaveLength(MAX_CLAIM_RECORDS);
  expect(claims.at(-1)?.timestamp).toBe(2);
});
