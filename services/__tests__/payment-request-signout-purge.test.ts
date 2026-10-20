import { describe, expect, test } from 'bun:test';

import { type AppEnvironment, envScopedStorageKey } from '@/config/app-environment';
import { parseWithMaps, stringifyWithMaps } from '@/services/json-maps';
import { paymentRequestStateKey } from '@/services/payment-request-store-read';
import {
  type PurgeStorage,
  allowPaymentRequestWrites,
  assertPaymentRequestWriteAllowed,
  blockPaymentRequestWrites,
  holdsSameRecoveryData,
  markPaymentRequestsBackedUp,
  ownerRecordKeysFromPhysical,
  paymentIdsInBackup,
  paymentRequestBackupLedgerKey,
  purgeOwnerPaymentRequests,
  signedOutOwner,
} from '@/services/payment-request-signout-purge';

const hex = (byte: string) => `0x${byte.repeat(32)}`;
const OWNER_A = `0x${'a'.repeat(40)}`;
const OWNER_B = `0x${'b'.repeat(40)}`;
const MAINNET = 1;
const SEPOLIA = 11155111;

function record(idByte: string, owner = OWNER_A) {
  return {
    paymentId: hex(idByte),
    noteAddressHashes: [hex('c1')],
    noteSecretsMap: new Map([[hex('c1'), hex('d1')]]),
    amount: '0x2386f26fc10000',
    tokenId: `0x${'e'.repeat(40)}`,
    tag: hex('22'),
    paymentPubKey: hex('33'),
    recipientAddress: owner,
    status: 'OPEN',
    createdAt: '0x1972d3f3a00',
    fulfilledByCommitments: [],
    consumedSlots: [],
  };
}

/**
 * localStorage + the same physical-key and Map-aware serialization the app's
 * LocalStorageService applies (services/sdk-storage.ts), so the purge runs
 * against what the browser actually holds.
 */
function browser(env: AppEnvironment) {
  const raw = new Map<string, string>();
  const storage: PurgeStorage = {
    async get<T>(key: string) {
      const value = raw.get(envScopedStorageKey(key, env));
      return value === undefined ? null : (parseWithMaps(value) as T);
    },
    async set<T>(key: string, value: T) {
      raw.set(envScopedStorageKey(key, env), stringifyWithMaps(value));
    },
    async delete(key: string) {
      raw.delete(envScopedStorageKey(key, env));
    },
  };
  return { raw, storage, ownerKeys: (owner: string) => ownerRecordKeysFromPhysical([...raw.keys()], owner, env) };
}

describe('sign-out purge of stored payment requests', () => {
  test('enumerates only the signed-out owner\'s record keys in the active environment', () => {
    const physical = [
      `v1:payment-request-state:${MAINNET}:${OWNER_A}_prod`,
      `v1:payment-request-state:${SEPOLIA}:${OWNER_A}_prod`,
      `v1:payment-request-state:${MAINNET}:${OWNER_A}`, // staging world
      `v1:payment-request-state:${MAINNET}:${OWNER_B}_prod`,
      `v1:payment-request-state:${MAINNET}_prod`, // legacy, owner-less
      `ppv2_account_export_v1:${OWNER_A}:1_prod`,
      'ppv2_theme',
    ];
    expect(ownerRecordKeysFromPhysical(physical, OWNER_A, 'prod').sort()).toEqual([
      paymentRequestStateKey(MAINNET, OWNER_A),
      paymentRequestStateKey(SEPOLIA, OWNER_A),
    ].sort());
    expect(ownerRecordKeysFromPhysical(physical, OWNER_A.toUpperCase().replace('0X', '0x'), 'staging'))
      .toEqual([paymentRequestStateKey(MAINNET, OWNER_A)]);
  });

  // What the app does at sign-out: block the owner's writes, then purge.
  async function signOut(storage: PurgeStorage, owner: string, keys: string[]) {
    blockPaymentRequestWrites(owner);
    try {
      return await purgeOwnerPaymentRequests(storage, owner, keys);
    } finally {
      allowPaymentRequestWrites(owner);
    }
  }

  test('removes only that owner\'s backed-up request keys; other owners and unrelated keys survive', async () => {
    const { raw, storage, ownerKeys } = browser('prod');
    await storage.set(paymentRequestStateKey(MAINNET, OWNER_A), { requests: [record('11')] });
    await storage.set(paymentRequestStateKey(SEPOLIA, OWNER_A), { requests: [record('12')] });
    await storage.set(paymentRequestStateKey(MAINNET, OWNER_B), { requests: [record('21', OWNER_B)] });
    raw.set(`v1:payment-request-state:${MAINNET}:${OWNER_A}`, 'staging-world record');
    raw.set('ppv2_theme', 'dark');
    raw.set(envScopedStorageKey(`ppv2_account_export_v1:${OWNER_A}:1`, 'prod'), 'notes');
    await markPaymentRequestsBackedUp(storage, OWNER_A, [hex('11'), hex('12')]);
    await markPaymentRequestsBackedUp(storage, OWNER_B, [hex('21')]);
    const untouched = new Map([...raw].filter(([k]) => !k.includes(OWNER_A) || !k.endsWith('_prod') || k.startsWith('ppv2_account')));

    const result = await signOut(storage, OWNER_A, ownerKeys(OWNER_A));

    expect(result).toEqual({ purged: 2, kept: 0, aborted: false });
    expect(await storage.get(paymentRequestStateKey(MAINNET, OWNER_A))).toBeNull();
    expect(await storage.get(paymentRequestStateKey(SEPOLIA, OWNER_A))).toBeNull();
    expect(await storage.get(paymentRequestBackupLedgerKey(OWNER_A))).toBeNull();
    // Everything else is byte-for-byte what it was, B's ledger included.
    expect(new Map(raw)).toEqual(untouched);
    expect(await storage.get(paymentRequestBackupLedgerKey(OWNER_B))).toEqual([hex('21')]);
  });

  test('a request with no backup is not lost', async () => {
    const { storage, ownerKeys } = browser('prod');
    const key = paymentRequestStateKey(MAINNET, OWNER_A);
    await storage.set(key, { requests: [record('11'), record('12')] });
    await markPaymentRequestsBackedUp(storage, OWNER_A, [hex('11')]);

    const result = await signOut(storage, OWNER_A, ownerKeys(OWNER_A));

    expect(result).toEqual({ purged: 1, kept: 1, aborted: false });
    const left = await storage.get<{ requests: ReturnType<typeof record>[] }>(key);
    expect(left?.requests.map((r) => r.paymentId)).toEqual([hex('12')]);
    // The secrets of the kept record survive intact.
    expect(left?.requests[0].noteSecretsMap).toEqual(new Map([[hex('c1'), hex('d1')]]));
  });

  test('an owner with no backup at all keeps every request', async () => {
    const { raw, storage, ownerKeys } = browser('staging');
    await storage.set(paymentRequestStateKey(SEPOLIA, OWNER_A), { requests: [record('11')] });
    const before = new Map(raw);
    const result = await signOut(storage, OWNER_A, ownerKeys(OWNER_A));
    expect(result).toEqual({ purged: 0, kept: 1, aborted: false });
    expect(new Map(raw)).toEqual(before);
  });

  test('an unreadable blob is left exactly as it is, and so is the ledger that may cover it', async () => {
    const { raw, storage, ownerKeys } = browser('prod');
    const physical = envScopedStorageKey(paymentRequestStateKey(MAINNET, OWNER_A), 'prod');
    raw.set(physical, stringifyWithMaps({ not: 'a request state' }));
    await markPaymentRequestsBackedUp(storage, OWNER_A, [hex('11')]);
    const result = await signOut(storage, OWNER_A, ownerKeys(OWNER_A));
    expect(result.kept).toBe(1);
    expect(raw.get(physical)).toBe(stringifyWithMaps({ not: 'a request state' }));
    expect(await storage.get(paymentRequestBackupLedgerKey(OWNER_A))).toEqual([hex('11')]);
  });

  test('signing back in mid-purge stops it before it touches what the new session wrote', async () => {
    const { storage, ownerKeys } = browser('prod');
    const key = paymentRequestStateKey(MAINNET, OWNER_A);
    await storage.set(key, { requests: [record('11')] });
    await markPaymentRequestsBackedUp(storage, OWNER_A, [hex('11')]);
    // The owner returns while the purge is reading: the block lifts and the
    // new session saves a fresh, unbacked request into the same blob.
    const racing: PurgeStorage = {
      ...storage,
      async get<T>(k: string) {
        const value = await storage.get<T>(k);
        if (k === key) {
          allowPaymentRequestWrites(OWNER_A);
          await storage.set(key, { requests: [record('11'), record('99')] });
        }
        return value;
      },
    };
    blockPaymentRequestWrites(OWNER_A);
    const result = await purgeOwnerPaymentRequests(racing, OWNER_A, ownerKeys(OWNER_A));
    allowPaymentRequestWrites(OWNER_A);
    expect(result.aborted).toBe(true);
    const left = await storage.get<{ requests: ReturnType<typeof record>[] }>(key);
    expect(left?.requests.map((r) => r.paymentId)).toEqual([hex('11'), hex('99')]);
  });

  test('a same-id backup entry covers the stored record only with the same recovery data', () => {
    const stored = record('11');
    // The single-payload shape: noteSecretsMap as tuples, ids in any case.
    const payload = { ...stored, paymentId: stored.paymentId.toUpperCase().replace('0X', '0x'), noteSecretsMap: [[hex('c1'), hex('d1')]] };
    expect(holdsSameRecoveryData(stored, payload)).toBe(true);
    expect(holdsSameRecoveryData(stored, { ...payload, noteSecretsMap: [[hex('c1'), hex('ff')]] })).toBe(false);
    expect(holdsSameRecoveryData(stored, { ...payload, tag: hex('99') })).toBe(false);
    // A legacy record's random key must be in the backup too.
    expect(holdsSameRecoveryData({ ...stored, paymentPrivKey: hex('44') }, payload)).toBe(false);
    expect(holdsSameRecoveryData({ ...stored, paymentPrivKey: hex('44') }, { ...payload, paymentPrivKey: hex('44') })).toBe(true);
    expect(holdsSameRecoveryData(undefined, payload)).toBe(false);
  });

  test('overlapping ledger writes keep every id', async () => {
    const { storage } = browser('prod');
    await Promise.all([
      markPaymentRequestsBackedUp(storage, OWNER_A, [hex('11')]),
      markPaymentRequestsBackedUp(storage, OWNER_A, [hex('12')]),
      markPaymentRequestsBackedUp(storage, OWNER_A, [hex('13')]),
    ]);
    expect(((await storage.get<string[]>(paymentRequestBackupLedgerKey(OWNER_A))) ?? []).sort())
      .toEqual([hex('11'), hex('12'), hex('13')]);
  });

  test('the ledger reads ids from the backup text the app serializes, and nothing else', () => {
    const backup = {
      kind: 'ppv2-payment-request-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      chains: { [String(MAINNET)]: { requests: [record('11')] } },
    };
    expect(paymentIdsInBackup(parseWithMaps(stringifyWithMaps(backup)))).toEqual([hex('11')]);
    expect(paymentIdsInBackup({ kind: 'ppv2-sdk-payment-request', paymentId: hex('11') })).toEqual([]);
    expect(paymentIdsInBackup(null)).toEqual([]);
  });

  test('a signed-out owner\'s record keys refuse writes until that owner signs in again', () => {
    const aKey = paymentRequestStateKey(MAINNET, OWNER_A);
    blockPaymentRequestWrites(OWNER_A.toUpperCase().replace('0X', '0x'));
    try {
      expect(() => assertPaymentRequestWriteAllowed(aKey)).toThrow();
      expect(() => assertPaymentRequestWriteAllowed(paymentRequestStateKey(MAINNET, OWNER_B))).not.toThrow();
      expect(() => assertPaymentRequestWriteAllowed(paymentRequestBackupLedgerKey(OWNER_A))).not.toThrow();
      expect(() => assertPaymentRequestWriteAllowed('ppv2_theme')).not.toThrow();
    } finally {
      allowPaymentRequestWrites(OWNER_A);
    }
    expect(() => assertPaymentRequestWriteAllowed(aKey)).not.toThrow();
  });

  describe('which identity changes are a sign-out', () => {
    const KEY = `0x${'c'.repeat(40)}`;
    const cases: [string, string | null, string | null, string, string | null][] = [
      ['wallet disconnect (header, settings, the wallet itself, embedded passkey wallet)', OWNER_A, null, 'disconnected', OWNER_A],
      ['signOutAccountKey with no wallet', KEY, null, 'disconnected', KEY],
      ['signOutAccountKey onto a connected wallet', KEY, OWNER_A, 'connected', KEY],
      ['account switch in the wallet', OWNER_A, OWNER_B, 'connected', OWNER_A],
      ['key sign-in over a wallet session', OWNER_A, KEY, 'connected', OWNER_A],
      ['reconnect blip is not a sign-out', OWNER_A, null, 'reconnecting', null],
      ['connecting is not a sign-out', OWNER_A, null, 'connecting', null],
      ['same owner (chain switch, key-source switch) is not a sign-out', OWNER_A, OWNER_A.toUpperCase().replace('0X', '0x'), 'connected', null],
      ['first sign-in is not a sign-out', null, OWNER_A, 'connected', null],
    ];
    for (const [label, prev, next, status, expected] of cases) {
      test(label, () => {
        expect(signedOutOwner(prev, next, status).signedOut).toBe(expected);
      });
    }

    test('a blip keeps the owner, so the return of the same wallet purges nothing', () => {
      const blip = signedOutOwner(OWNER_A, null, 'reconnecting');
      expect(blip.owner).toBe(OWNER_A);
      expect(signedOutOwner(blip.owner, OWNER_A, 'connected').signedOut).toBeNull();
    });
  });
});
