import { describe, expect, test } from 'bun:test';

import { envScopedStorageKey } from '@/config/app-environment';
import { openBackupFileTarget, writeBackupFileTarget } from '@/services/backup-file-proof';
import { parseWithMaps, stringifyWithMaps } from '@/services/json-maps';
import { paymentRequestStateKey, readAllPaymentRequestStatesNoWrite } from '@/services/payment-request-store-read';
import {
  type PurgeStorage,
  allowPaymentRequestWrites,
  blockPaymentRequestWrites,
  ledgerDeliveredBackup,
  ownerRecordKeysFromPhysical,
  purgeOwnerPaymentRequests,
} from '@/services/payment-request-signout-purge';

// DEV-497, Mike's exact flow: an unregistered wallet creates a request, picks
// "Download backup", saves the file, signs out. The request key must be gone.
// It was not, because that press took a plain download, which proves nothing.
// The press now opens the save target and the request's backup is written to
// it once it exists. Same modules, same order the modal runs them in.

const hex = (byte: string) => `0x${byte.repeat(32)}`;
const OWNER = `0x${'a'.repeat(40)}`;
const SEPOLIA = 11155111;

function storedRecord() {
  return {
    paymentId: hex('11'),
    noteAddressHashes: [hex('c1')],
    noteSecretsMap: new Map([[hex('c1'), hex('d1')]]),
    amount: '0x2386f26fc10000',
    tokenId: `0x${'e'.repeat(40)}`,
    tag: hex('22'),
    paymentPubKey: hex('33'),
    recipientAddress: OWNER,
    status: 'OPEN',
    createdAt: '0x1972d3f3a00',
    fulfilledByCommitments: [],
    consumedSlots: [],
  };
}

function browser() {
  const raw = new Map<string, string>([['ppv2_theme', 'dark']]);
  const storage: PurgeStorage = {
    async get<T>(key: string) {
      const value = raw.get(envScopedStorageKey(key, 'staging'));
      return value === undefined ? null : (parseWithMaps(value) as T);
    },
    async set<T>(key: string, value: T) { raw.set(envScopedStorageKey(key, 'staging'), stringifyWithMaps(value)); },
    async delete(key: string) { raw.delete(envScopedStorageKey(key, 'staging')); },
  };
  return { raw, storage };
}

/** A save dialog: resolves a handle once "the user picked a place", or rejects as a dismissal. */
function pickerHost(outcome: 'save' | 'cancel') {
  const written: string[] = [];
  let calls = 0;
  const host = {
    showSaveFilePicker: async () => {
      calls += 1;
      if (outcome === 'cancel') throw Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' });
      return {
        async createWritable() {
          let text = '';
          return { async write(d: string) { text += d; }, async close() { written.push(text); } };
        },
      };
    },
  };
  return { host, written, calls: () => calls };
}

/** The modal's sequence: open at the press, create, build the backup, write, ledger. */
async function mikesFlow(storage: PurgeStorage, outcome: 'save' | 'cancel', hostOverride?: object) {
  const picker = pickerHost(outcome);
  // 1. The "Download backup" press, before the request exists.
  const targetAtPress = openBackupFileTarget(hostOverride ?? picker.host, `privacy-pools-request-backup-${OWNER}.json`);
  // 2. The SDK persists the request.
  await storage.set(paymentRequestStateKey(SEPOLIA, OWNER), { requests: [storedRecord()] });
  // 3. The backup is built the way exportAllPaymentRequests builds it.
  const text = stringifyWithMaps({
    kind: 'ppv2-payment-request-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    chains: await readAllPaymentRequestStatesNoWrite(storage, [SEPOLIA], OWNER),
  });
  // 4. Written to the target opened at the press; only a confirmed write is ledgered.
  const target = await targetAtPress;
  let proved = false;
  if (target && target !== 'cancelled') proved = await writeBackupFileTarget(target, text);
  if (proved) await ledgerDeliveredBackup(storage, OWNER, text, parseWithMaps);
  return { picker, proved, text };
}

async function signOut(raw: Map<string, string>, storage: PurgeStorage) {
  blockPaymentRequestWrites(OWNER);
  try {
    return await purgeOwnerPaymentRequests(storage, OWNER, ownerRecordKeysFromPhysical([...raw.keys()], OWNER, 'staging'));
  } finally {
    allowPaymentRequestWrites(OWNER);
  }
}

describe('DEV-497: create unregistered request, Download backup, save, sign out', () => {
  test('a saved backup makes sign-out remove the request key, and only that key', async () => {
    const { raw, storage } = browser();
    const { picker, proved, text } = await mikesFlow(storage, 'save');
    expect(picker.calls()).toBe(1);
    expect(proved).toBe(true);
    // The file holds the request, secrets included, in the importer's shape.
    expect(picker.written).toEqual([text]);
    const file = parseWithMaps(picker.written[0]) as { chains: Record<string, { requests: { paymentId: string; noteSecretsMap: Map<string, string> }[] }> };
    expect(file.chains[String(SEPOLIA)].requests[0].paymentId).toBe(hex('11'));
    expect(file.chains[String(SEPOLIA)].requests[0].noteSecretsMap.get(hex('c1'))).toBe(hex('d1'));
    expect(raw.has(paymentRequestStateKey(SEPOLIA, OWNER))).toBe(true);

    const result = await signOut(raw, storage);

    expect(result).toEqual({ purged: 1, kept: 0, aborted: false });
    expect(raw.has(paymentRequestStateKey(SEPOLIA, OWNER))).toBe(false);
    expect([...raw.keys()]).toEqual(['ppv2_theme']);
  });

  test('a dismissed save dialog leaves the request in place', async () => {
    const { raw, storage } = browser();
    const { proved } = await mikesFlow(storage, 'cancel');
    expect(proved).toBe(false);
    const result = await signOut(raw, storage);
    expect(result).toEqual({ purged: 0, kept: 1, aborted: false });
    expect(raw.has(paymentRequestStateKey(SEPOLIA, OWNER))).toBe(true);
  });

  test('without a save dialog (Firefox, Safari) nothing is proved and the request stays', async () => {
    expect(await openBackupFileTarget({}, 'x.json')).toBeNull();
    expect(await openBackupFileTarget(undefined, 'x.json')).toBeNull();
    // The whole flow on such a browser: the plain download it falls back to
    // ledgers nothing, so sign-out keeps the request.
    const { raw, storage } = browser();
    const { proved } = await mikesFlow(storage, 'save', {});
    expect(proved).toBe(false);
    expect(await signOut(raw, storage)).toEqual({ purged: 0, kept: 1, aborted: false });
    expect(raw.has(paymentRequestStateKey(SEPOLIA, OWNER))).toBe(true);
  });
});
