// The address book (saved names + recipient history) inside the REAL account
// backup entry points: only the password-encrypted backup carries it, an old
// backup without it still imports, a bad field is skipped and the notes still
// import, and a name already saved on this device is never overwritten.
import { describe, expect, test } from 'bun:test';
import { encryptAccountExportCore, parseAccountBackupCore, prepareAccountBackupCore, type AddressBookImportResult, type AddressBookStore, type PaymentRequestStateStore } from '@/services/account-backup-core';
import {
  ADDRESS_BOOK_BACKUP_FIELD,
  addNewContact,
  canonicalAddress,
  mergeAddressBookBackup,
  MAX_RECIPIENT_RECORDS,
  parseAddressBookBackup,
  parseRecipientRecords,
  roundToDay,
  upsertRecipientRecord,
  type Contact,
  type RecipientRecord,
} from '@/services/address-book-core';
import type { AccountExport } from '@/services/sdk-types';

const addr = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, '0')}`;
const OWNER = addr(0x111);
const CHAIN = 11155111;
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const DAY = roundToDay(NOW);
const PAYEE = '0x71c7656ec7ab88b098defb751b7401b5f6d8976f';
const STELLAR = 'G' + 'A'.repeat(55);
const disp = (a: string) => canonicalAddress(a)!.display;

const noRequests: PaymentRequestStateStore = {
  async load() { return { state: null, loadError: null }; },
  async save() { /* none */ },
};
const accountExport = { notes: [], syncCursor: '0x1' } as unknown as AccountExport;

function memoryBook(seed: { contacts?: Contact[]; recipients?: RecipientRecord[] } = {}) {
  const state = { contacts: seed.contacts ?? [], recipients: seed.recipients ?? [] };
  const store: AddressBookStore = {
    load: () => ({ contacts: state.contacts, recipients: state.recipients }),
    restore: (_owner, backup) => {
      const merged = mergeAddressBookBackup(state, backup, NOW);
      state.contacts = merged.contacts;
      state.recipients = merged.recipients;
      return { added: merged.added };
    },
  };
  return { store, state };
}

const deviceA = () => memoryBook({
  contacts: [{ address: disp(PAYEE), name: 'Cold wallet', createdAt: DAY, updatedAt: DAY }],
  recipients: [{ address: disp(PAYEE), chainId: 1, lastUsedAt: DAY }, { address: STELLAR, chainId: 4114, lastUsedAt: DAY }],
});

describe('recipient history', () => {
  test('address + chain + UTC day only, one per address, newest last, bounded', () => {
    let list: RecipientRecord[] = [];
    list = upsertRecipientRecord(list, PAYEE, 1, NOW);
    list = upsertRecipientRecord(list, STELLAR, 4114, NOW + 1000);
    list = upsertRecipientRecord(list, PAYEE.toUpperCase().replace('0X', '0x'), 10, NOW + 2000);
    expect(list.map((r) => r.address)).toEqual([STELLAR, disp(PAYEE)]);
    expect(list[1]).toEqual({ address: disp(PAYEE), chainId: 10, lastUsedAt: DAY });
    expect(Object.keys(list[0]).sort()).toEqual(['address', 'chainId', 'lastUsedAt']);
    expect(upsertRecipientRecord(list, 'not-an-address', 1, NOW)).toEqual(list);
    let big: RecipientRecord[] = [];
    for (let i = 1; i <= MAX_RECIPIENT_RECORDS + 5; i++) big = upsertRecipientRecord(big, addr(i), 1, NOW);
    expect(big).toHaveLength(MAX_RECIPIENT_RECORDS);
    expect(parseRecipientRecords([{ address: PAYEE, chainId: 1, lastUsedAt: NOW, txHash: '0x1', commitment: '0x2' }])[0]).toEqual({ address: disp(PAYEE), chainId: 1, lastUsedAt: DAY });
  });
});

describe('manual add', () => {
  test('validated per format, EVM checksummed, deduped, needs a name', () => {
    const r = addNewContact([], PAYEE, 'Alice', NOW);
    expect(r.error).toBeNull();
    expect(r.list[0].address).toBe(disp(PAYEE));
    expect(addNewContact(r.list, PAYEE.toUpperCase().replace('0X', '0x'), 'Again', NOW).error).toMatch(/already saved/);
    expect(addNewContact([], '0x123', 'x', NOW).error).toMatch(/full EVM/);
    expect(addNewContact([], PAYEE, '   ', NOW).error).toMatch(/name/);
    expect(addNewContact([], STELLAR, 'Stella', NOW).list[0].address).toBe(STELLAR);
  });
});

describe('backup round trip', () => {
  test('a password-encrypted backup carries the address book and restores it on another device', async () => {
    const a = deviceA();
    const prepared = await prepareAccountBackupCore(noRequests, OWNER, CHAIN, accountExport, 'hunter22', a.store);
    expect(prepared.serialized).not.toContain('Cold wallet'); // inside the ciphertext, not beside it
    const b = memoryBook();
    let result: AddressBookImportResult | null = null;
    const restored = await parseAccountBackupCore(noRequests, OWNER, CHAIN, prepared.serialized, 'hunter22', b.store, (r) => { result = r; });
    expect(result).toEqual({ status: 'restored', added: 3 });
    expect(b.state.contacts.map((c) => c.name)).toEqual(['Cold wallet']);
    expect(b.state.recipients.map((r) => r.address).sort()).toEqual([disp(PAYEE), STELLAR].sort());
    // The SDK never sees the ppv2 field.
    expect(ADDRESS_BOOK_BACKUP_FIELD in (restored as object)).toBe(false);
    expect(restored.notes).toEqual([]);
  });

  test('a PLAIN backup never carries recipient addresses or names', async () => {
    const prepared = await prepareAccountBackupCore(noRequests, OWNER, CHAIN, accountExport, undefined, deviceA().store);
    expect(prepared.serialized).not.toContain(ADDRESS_BOOK_BACKUP_FIELD);
    expect(prepared.serialized.toLowerCase()).not.toContain(PAYEE);
    expect(prepared.serialized).not.toContain('Cold wallet');
  });

  test('a hand-made plain file with the field: ignored, never reaches the SDK', async () => {
    const b = memoryBook();
    const raw = JSON.stringify({ ...accountExport, [ADDRESS_BOOK_BACKUP_FIELD]: { v: 1, contacts: [{ address: PAYEE, name: 'x' }], recipients: [] } });
    const out = await parseAccountBackupCore(noRequests, OWNER, CHAIN, raw, undefined, b.store);
    expect(ADDRESS_BOOK_BACKUP_FIELD in (out as object)).toBe(false);
    expect(b.state.contacts).toEqual([]);
  });

  test('an old backup without the field imports exactly as before', async () => {
    const old = await prepareAccountBackupCore(noRequests, OWNER, CHAIN, accountExport, 'hunter22'); // no address book store: the old producer
    const b = memoryBook();
    let result: AddressBookImportResult | null = null;
    const restored = await parseAccountBackupCore(noRequests, OWNER, CHAIN, old.serialized, 'hunter22', b.store, (r) => { result = r; });
    expect(result).toEqual({ status: 'absent' });
    expect(restored.notes).toEqual([]);
  });

  test('a malformed or oversized field is skipped with a plain message; the notes still import', async () => {
    for (const bad of [
      { v: 99, contacts: [], recipients: [] },
      { v: 1, contacts: 'nope', recipients: [] },
      'garbage',
      { v: 1, contacts: Array.from({ length: 20000 }, (_, i) => ({ address: addr(i + 1), name: 'n'.repeat(30) })), recipients: [] },
    ]) {
      const parsed = parseAddressBookBackup(bad);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.length).toBeGreaterThan(0);
        expect(parsed.error).not.toMatch(/—/);
      }
    }
    // Through the real entry point: an encrypted envelope whose field is junk.
    const junk = await encryptAccountExportCore(OWNER, CHAIN, { ...accountExport, [ADDRESS_BOOK_BACKUP_FIELD]: { v: 99 } } as never, 'hunter22');
    let junkResult: AddressBookImportResult | null = null;
    const fromJunk = await parseAccountBackupCore(noRequests, OWNER, CHAIN, JSON.stringify(junk), 'hunter22', memoryBook().store, (r) => { junkResult = r; });
    expect(fromJunk.notes).toEqual([]);
    expect(junkResult).toEqual({ status: 'skipped', message: 'The saved addresses in this backup come from a newer version and were skipped.' });
    const a = deviceA();
    const sabotaged: AddressBookStore = { ...a.store, load: () => { throw new Error('boom'); } };
    const prepared = await prepareAccountBackupCore(noRequests, OWNER, CHAIN, accountExport, 'hunter22', sabotaged);
    const restored = await parseAccountBackupCore(noRequests, OWNER, CHAIN, prepared.serialized, 'hunter22', memoryBook().store);
    expect(restored.notes).toEqual([]); // a failing address book never fails the notes backup
  });

  test('restore never overwrites a name already saved here', () => {
    const here = { contacts: [{ address: disp(PAYEE), name: 'Mine', createdAt: DAY, updatedAt: DAY }], recipients: [] };
    const merged = mergeAddressBookBackup(here, { contacts: [{ address: disp(PAYEE), name: 'Theirs', createdAt: DAY, updatedAt: DAY }], recipients: [] }, NOW);
    expect(merged.contacts.map((c) => c.name)).toEqual(['Mine']);
    expect(merged.kept).toBe(1);
  });

  test('a backup for another wallet is still refused before anything is restored', async () => {
    const prepared = await prepareAccountBackupCore(noRequests, OWNER, CHAIN, accountExport, 'hunter22', deviceA().store);
    const b = memoryBook();
    await expect(parseAccountBackupCore(noRequests, addr(0x222), CHAIN, prepared.serialized, 'hunter22', b.store)).rejects.toThrow(/belongs to wallet/);
    expect(b.state.contacts).toEqual([]);
  });
});
