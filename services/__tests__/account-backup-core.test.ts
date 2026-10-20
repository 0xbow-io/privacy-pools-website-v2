// REAL-API backup coverage: these tests drive the actual public backup
// entry points (prepareAccountBackupCore / parseAccountBackupCore /
// encryptAccountExportCore — the exact functions wallet-backup-encryption
// wraps with device storage) with an in-memory store that reuses the REAL
// no-write reader for loads. Asserts both the returned account data and the
// FINAL PERSISTED payment-request state.

import { describe, expect, test } from 'bun:test';

import {
  backupTextNeedsPassword,
  mergePaymentRequestRecords,
  parseAccountBackupCore,
  prepareAccountBackupCore,
  type PaymentRequestStateStore,
} from '@/services/account-backup-core';
import {
  paymentRequestStateKey,
  readPaymentRequestStateNoWriteDetailed,
} from '@/services/payment-request-store-read';
import type { AccountExport } from '@/services/sdk-types';

const hash = (n: number): `0x${string}` => `0x${n.toString(16).padStart(64, '0')}`;
const addr = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, '0')}`;
const OWNER = addr(0x111);
const CHAIN = 11155111;

function v2Record(n: number, overrides: Record<string, unknown> = {}) {
  return {
    paymentId: hash(n),
    noteAddressHashes: [hash(n + 1)],
    noteSecretsMap: new Map([[hash(n + 1), hash(n + 2)]]),
    amount: '0xde0b6b3a7640000',
    tokenId: addr(0xeee),
    tag: hash(n + 3),
    paymentPubKey: hash(n + 4),
    recipientAddress: OWNER,
    status: 'OPEN' as const,
    createdAt: '0x19794ba2c00',
    fulfilledByCommitments: [],
    ...overrides,
  };
}

const accountExport: AccountExport = {
  notes: [],
  syncCursor: '0x123',
} as unknown as AccountExport;

/**
 * In-memory store wired through the REAL no-write reader (the same load
 * path the device store uses), recording every save so tests can assert
 * the final persisted state and that reads never wrote.
 */
function memoryStore(seedRaw?: unknown) {
  const mem = new Map<string, unknown>();
  if (seedRaw !== undefined) mem.set(paymentRequestStateKey(CHAIN, OWNER), seedRaw);
  const saves: { chainId: number; owner: string; state: unknown }[] = [];
  const storage = {
    async get<T>(key: string): Promise<T | null> {
      return (mem.has(key) ? (mem.get(key) as T) : null);
    },
  };
  const store: PaymentRequestStateStore = {
    load(chainId, owner) {
      return readPaymentRequestStateNoWriteDetailed(storage, chainId, owner);
    },
    async save(chainId, owner, state) {
      saves.push({ chainId, owner, state });
      mem.set(paymentRequestStateKey(chainId, owner), state);
    },
  };
  return { store, saves, mem };
}

async function loadPersisted(source: ReturnType<typeof memoryStore>) {
  const { state } = await source.store.load(CHAIN, OWNER);
  return state;
}

describe('account backup round-trip through the REAL public APIs', () => {
  test('plain backup: prepare on device A, parse on device B, state persists on B', async () => {
    const deviceA = memoryStore({ requests: [v2Record(1)] });
    const deviceB = memoryStore();

    const prepared = await prepareAccountBackupCore(deviceA.store, OWNER, CHAIN, accountExport);
    expect(prepared.encrypted).toBe(false);
    expect(prepared.warning).toBeNull();
    // Preparing a backup is a pure read — nothing written on A.
    expect(deviceA.saves.length).toBe(0);

    const restored = await parseAccountBackupCore(deviceB.store, OWNER, CHAIN, prepared.serialized);
    expect(restored.syncCursor).toBe(accountExport.syncCursor);

    const persisted = await loadPersisted(deviceB);
    expect(persisted?.requests.length).toBe(1);
    expect(persisted?.requests[0].paymentId).toBe(hash(1));
    // The slot map survived as a REAL Map through serialize → parse → save.
    expect(persisted?.requests[0].noteSecretsMap.get(hash(2))).toBe(hash(3));
  });

  test('AES-256-GCM backup: password round-trip; wrong/missing password rejected before any write', async () => {
    const deviceA = memoryStore({ requests: [v2Record(1)] });
    const deviceB = memoryStore();

    const prepared = await prepareAccountBackupCore(deviceA.store, OWNER, CHAIN, accountExport, 'hunter22');
    expect(prepared.encrypted).toBe(true);
    // The serialized payload is the encrypted envelope — no plaintext leak.
    expect(prepared.serialized.includes(hash(3))).toBe(false);

    await expect(
      parseAccountBackupCore(deviceB.store, OWNER, CHAIN, prepared.serialized),
    ).rejects.toThrow(/password-protected/);
    await expect(
      parseAccountBackupCore(deviceB.store, OWNER, CHAIN, prepared.serialized, 'wrong-password'),
    ).rejects.toThrow(/Wrong password/);
    expect(deviceB.saves.length).toBe(0);

    const restored = await parseAccountBackupCore(deviceB.store, OWNER, CHAIN, prepared.serialized, 'hunter22');
    expect(restored.syncCursor).toBe(accountExport.syncCursor);
    const persisted = await loadPersisted(deviceB);
    expect(persisted?.requests[0].noteSecretsMap.get(hash(2))).toBe(hash(3));
  }, 30_000);

  test('wrong owner / wrong chain metadata rejects an encrypted backup before decrypt or write', async () => {
    const deviceA = memoryStore({ requests: [v2Record(1)] });
    const prepared = await prepareAccountBackupCore(deviceA.store, OWNER, CHAIN, accountExport, 'hunter22');

    const deviceB = memoryStore();
    await expect(
      parseAccountBackupCore(deviceB.store, addr(0x222), CHAIN, prepared.serialized, 'hunter22'),
    ).rejects.toThrow(/belongs to wallet/);
    await expect(
      parseAccountBackupCore(deviceB.store, OWNER, 1, prepared.serialized, 'hunter22'),
    ).rejects.toThrow(/chainId/);
    expect(deviceB.saves.length).toBe(0);
  }, 30_000);

  test('local FULFILLED wins over the backup\'s OPEN copy (no regression, no write)', async () => {
    const deviceA = memoryStore({ requests: [v2Record(1, { status: 'OPEN' })] });
    const prepared = await prepareAccountBackupCore(deviceA.store, OWNER, CHAIN, accountExport);

    // Same request meanwhile fulfilled locally on device B.
    const deviceB = memoryStore({
      requests: [v2Record(1, { status: 'FULFILLED', fulfilledByCommitments: [hash(0xf1)] })],
    });
    await parseAccountBackupCore(deviceB.store, OWNER, CHAIN, prepared.serialized);

    // Nothing restored → nothing rewritten; local status stands.
    expect(deviceB.saves.length).toBe(0);
    const persisted = await loadPersisted(deviceB);
    expect(persisted?.requests[0].status).toBe('FULFILLED');
  });

  test('mixed-case paymentIds dedupe case-insensitively', () => {
    const local = [v2Record(0xaa)];
    const importedUpper = [{
      ...v2Record(0xaa),
      paymentId: hash(0xaa).toUpperCase().replace('0X', '0x'),
    }, v2Record(0xbb)];
    const { merged, restored, skipped } = mergePaymentRequestRecords(local, importedUpper);
    expect(restored).toBe(1);
    expect(skipped).toBe(1);
    expect(merged.length).toBe(2);
    // The local casing/record wins for the duplicate.
    expect(merged[0].paymentId).toBe(hash(0xaa));
  });

  test('historical pre-v2 record (random paymentPrivKey, no hashes, object map) survives export + import', async () => {
    // Raw storage exactly as the pre-v2.0 SDK persisted it.
    const legacyRaw = {
      requests: [{
        paymentId: hash(1),
        paymentPrivKey: hash(9),
        paymentPubKey: hash(7),
        noteSecretsMap: { [hash(2)]: hash(4) },
        amount: '0xde0b6b3a7640000',
        tokenId: addr(0xeee),
        tag: hash(6),
        recipientAddress: OWNER,
        status: 'OPEN',
        createdAt: '0x19794ba2c00',
        fulfilledByCommitments: [],
      }],
    };
    const deviceA = memoryStore(legacyRaw);
    const prepared = await prepareAccountBackupCore(deviceA.store, OWNER, CHAIN, accountExport);
    // Export is a pure read: the raw legacy blob is untouched on A.
    expect(deviceA.saves.length).toBe(0);
    expect(deviceA.mem.get(paymentRequestStateKey(CHAIN, OWNER))).toBe(legacyRaw);

    const deviceB = memoryStore();
    await parseAccountBackupCore(deviceB.store, OWNER, CHAIN, prepared.serialized);
    const persisted = await loadPersisted(deviceB);
    const record = persisted?.requests[0] as unknown as Record<string, unknown>;
    // The destructive-migration regression: the random key must be there.
    expect(record.paymentPrivKey).toBe(hash(9));
    expect(record.noteAddressHashes).toEqual([hash(2)]);
    expect((record.noteSecretsMap as Map<string, string>).get(hash(2))).toBe(hash(4));
  });

  test('unreadable local store → warning on the prepared backup (recovery data missing)', async () => {
    const deviceA = memoryStore({ requests: 'garbage' });
    const prepared = await prepareAccountBackupCore(deviceA.store, OWNER, CHAIN, accountExport);
    expect(prepared.warning).toContain("couldn't be read");
  });

  test('invalid imported payment-request blob is skipped without touching local state', async () => {
    const deviceB = memoryStore({ requests: [v2Record(5)] });
    // Hand-built envelope with a corrupt paymentRequests shape.
    const envelope = JSON.stringify({
      notes: [],
      syncCursor: '0x1',
      paymentRequests: { requests: [{ paymentId: 'not-hex' }] },
    });
    const restored = await parseAccountBackupCore(deviceB.store, OWNER, CHAIN, envelope);
    expect(restored.syncCursor).toBe('0x1');
    expect(deviceB.saves.length).toBe(0);
    const persisted = await loadPersisted(deviceB);
    expect(persisted?.requests[0].paymentId).toBe(hash(5));
  });
});

/**
 * The one-time transfer receipt's "raw JSON" fallback.
 *
 * The success screen tells an EVM recipient to paste this payload into
 * Actions > Privacy & keys > Import Notes, and that instruction is only true if
 * THIS parser accepts the producer's exact output. It nearly shipped pointing
 * at Payments > Import Note instead, which decodes a link/base64 receipt or a
 * Sui `ppv2-sui-note` and silently truncates pretty-printed JSON at the first
 * newline (services/note-receipt.ts) - so the recipient would have got
 * "Couldn't read that receipt" while the sender had already been told the
 * receipt was secured and could close the only screen showing it.
 *
 * The producer is components/transfer-modal-provider.tsx, which builds
 * `{ notes, syncCursor, owner, chainId }` and serialises it with
 * JSON.stringify(payload, null, 2). Both the shape and the pretty-printing
 * matter, so this reproduces them literally.
 */
describe('transfer receipt raw-JSON fallback', () => {
  const receiptNote = {
    commitment: hash(0x51),
    value: '0x16345785d8a0000',
    tokenId: addr(0xeee),
    label: hash(0x52),
    noteSecret: hash(0x53),
    ownerAddress: OWNER,
    status: 'active',
  };

  test('parses the exact pretty-printed payload the receipt screen hands the recipient', async () => {
    const { store } = memoryStore();
    const payload = JSON.stringify(
      { notes: [receiptNote], syncCursor: '0x0', owner: OWNER, chainId: CHAIN },
      null,
      2,
    );
    // Pretty-printing is the part that breaks the OTHER importer; assert it is
    // really present so a future formatting change cannot quietly weaken this.
    expect(payload).toContain('\n');

    const parsed = await parseAccountBackupCore(store, OWNER, CHAIN, payload);
    expect(parsed.notes).toHaveLength(1);
    expect(parsed.notes[0]).toMatchObject({ commitment: receiptNote.commitment, ownerAddress: OWNER });
  });

  test('rejects a payload with no notes array rather than importing an empty account', async () => {
    const { store } = memoryStore();
    const payload = JSON.stringify({ syncCursor: '0x0', owner: OWNER, chainId: CHAIN }, null, 2);
    await expect(parseAccountBackupCore(store, OWNER, CHAIN, payload)).rejects.toThrow(
      /expected account export shape/i,
    );
  });
});

describe('the import form asks for a password exactly when the import needs one (DEV-460)', () => {
  test('an encrypted backup from the real export needs a password, a plain one does not', async () => {
    const device = memoryStore({ requests: [v2Record(1)] });
    const encrypted = await prepareAccountBackupCore(device.store, OWNER, CHAIN, accountExport, 'hunter22');
    const plain = await prepareAccountBackupCore(device.store, OWNER, CHAIN, accountExport);
    expect(backupTextNeedsPassword(encrypted.serialized)).toBe(true);
    expect(backupTextNeedsPassword(plain.serialized)).toBe(false);
    // The detector agrees with the importer: without a password it refuses.
    await expect(parseAccountBackupCore(memoryStore().store, OWNER, CHAIN, encrypted.serialized)).rejects.toThrow();
  });

  test('text that is not a backup never shows the field', () => {
    expect(backupTextNeedsPassword('')).toBe(false);
    expect(backupTextNeedsPassword('not json')).toBe(false);
    expect(backupTextNeedsPassword('{"kind":"ppv2-password-backup","version":2}')).toBe(false);
  });

  test('"Load File" goes through the same detection as a paste', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(new URL('.', import.meta.url).pathname, '..', '..', 'components', 'account-recovery-modal-provider.tsx'),
      'utf8',
    ) as string;
    const pick = src.slice(src.indexOf('const handlePickFile = useCallback'), src.indexOf('const handleImport = useCallback'));
    expect(pick).toContain('handleImportPayloadChange(result);');
    expect(pick).not.toContain('setImportPayload(result);');
  });
});
