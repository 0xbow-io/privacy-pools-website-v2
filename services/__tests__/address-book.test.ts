import { describe, expect, test } from 'bun:test';
import {
  addressFormatOf,
  applyContactsImport,
  buildContactsExport,
  canonicalAddress,
  cleanContactName,
  CONTACTS_FILE_TYPE,
  importSummary,
  MAX_CONTACTS,
  MAX_CONTACT_NAME_LENGTH,
  MAX_IMPORT_BYTES,
  parseContacts,
  parseContactsImport,
  parseCsv,
  planContactsImport,
  roundToDay,
  setContactName,
  type Contact,
} from '../address-book-core';

const NOW = Date.UTC(2026, 9, 28, 15, 42, 7);
const DAY = roundToDay(NOW);
const A = '0x71c2000000000000000000000000000000009fa3';
const A_CHECKSUM = canonicalAddress(A)!.display;
const B = '0x' + 'b'.repeat(40);
const SUI = '0x' + 'a1'.repeat(32);
const STELLAR = 'G' + 'A'.repeat(55);
const evmN = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

describe('address formats', () => {
  test('classifies EVM, Sui and Stellar; rejects the rest', () => {
    expect(addressFormatOf(A)).toBe('evm');
    expect(addressFormatOf(SUI)).toBe('sui');
    expect(addressFormatOf(STELLAR)).toBe('stellar');
    expect(addressFormatOf('vitalik.eth')).toBeNull();
    expect(addressFormatOf('0x123')).toBeNull();
    expect(addressFormatOf('g' + 'a'.repeat(55))).toBeNull();
  });
  test('EVM and Sui dedupe case-insensitively; Stellar is exact', () => {
    expect(canonicalAddress(A.toUpperCase().replace('0X', '0x'))!.key).toBe(A);
    expect(canonicalAddress(A)!.display).toBe(A_CHECKSUM);
    expect(A_CHECKSUM).not.toBe(A);
    expect(canonicalAddress(SUI.toUpperCase().replace('0X', '0x'))!.key).toBe(SUI);
    expect(canonicalAddress(STELLAR)!.key).toBe(STELLAR);
  });
});

describe('contact names', () => {
  test('cleaned, bounded, control and bidi characters dropped', () => {
    expect(cleanContactName('  Alice\n  Smith ')).toBe('Alice Smith');
    expect(cleanContactName('a‮b')).toBe('a b');
    expect(Array.from(cleanContactName('x'.repeat(100))).length).toBe(MAX_CONTACT_NAME_LENGTH);
    expect(cleanContactName(42)).toBe('');
  });

  test('set, rename, clear; one per address; timestamps are UTC days', () => {
    let r = setContactName([], A, 'Alice', NOW);
    expect(r.error).toBeNull();
    expect(r.list).toEqual([{ address: A_CHECKSUM, name: 'Alice', createdAt: DAY, updatedAt: DAY }]);
    r = setContactName(r.list, A.toUpperCase().replace('0X', '0x'), 'Alice W', NOW + 3 * 86_400_000);
    expect(r.list).toHaveLength(1);
    expect(r.list[0]).toMatchObject({ name: 'Alice W', createdAt: DAY, updatedAt: DAY + 3 * 86_400_000 });
    r = setContactName(r.list, A, '   ', NOW);
    expect(r.list).toEqual([]);
    expect(setContactName([], 'nope', 'x', NOW).error).toBeTruthy();
  });

  test('a full list refuses a new contact instead of dropping one', () => {
    const full: Contact[] = Array.from({ length: MAX_CONTACTS }, (_, i) => ({ address: canonicalAddress(evmN(i + 1))!.display, name: `n${i}`, createdAt: DAY, updatedAt: DAY }));
    const r = setContactName(full, B, 'Bob', NOW);
    expect(r.error).toMatch(/full/);
    expect(r.list).toHaveLength(MAX_CONTACTS);
    // Renaming an existing one still works.
    expect(setContactName(full, evmN(1), 'renamed', NOW).error).toBeNull();
  });

  test('stored rows keep only address, name and day timestamps', () => {
    const parsed = parseContacts([
      { address: A, name: 'Alice', createdAt: NOW, updatedAt: NOW, chainId: 1, txHash: '0x' + '1'.repeat(64), commitment: '0x9', label: '0x8' },
      { address: 'bad', name: 'x' },
      { address: B, name: '' },
      null,
    ], NOW);
    expect(parsed).toEqual([{ address: A_CHECKSUM, name: 'Alice', createdAt: DAY, updatedAt: DAY }]);
    expect(Object.keys(parsed[0]).sort()).toEqual(['address', 'createdAt', 'name', 'updatedAt']);
  });
});

describe('export / import', () => {
  const list: Contact[] = [
    { address: A_CHECKSUM, name: 'Alice', createdAt: DAY, updatedAt: DAY },
    { address: STELLAR, name: 'Stella', createdAt: DAY, updatedAt: DAY },
    { address: SUI, name: 'Sui pal', createdAt: DAY, updatedAt: DAY },
  ];

  test('round trip is lossless and the file holds nothing else', () => {
    const text = buildContactsExport(list);
    const file = JSON.parse(text);
    expect(file.type).toBe(CONTACTS_FILE_TYPE);
    expect(file.version).toBe(1);
    expect(Object.keys(file).sort()).toEqual(['contacts', 'type', 'version']);
    for (const c of file.contacts) expect(Object.keys(c).sort()).toEqual(['address', 'createdAt', 'name', 'updatedAt']);
    const parsed = parseContactsImport(text, NOW);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.invalid).toBe(0);
      expect(parseContacts(parsed.contacts, NOW)).toEqual(parseContacts(list, NOW));
    }
  });

  test('malformed files get one plain error each', () => {
    const bad = (t: string) => { const r = parseContactsImport(t, NOW); return r.ok ? null : r.error; };
    expect(bad('')).toMatch(/empty/);
    expect(bad('{not json')).toMatch(/could not be read/);
    expect(bad('{"type":"something-else","contacts":[]}')).toMatch(/not a contacts file/);
    expect(bad(JSON.stringify({ type: CONTACTS_FILE_TYPE, version: 99, contacts: [] }))).toMatch(/newer version/);
    expect(bad(JSON.stringify({ type: CONTACTS_FILE_TYPE, version: 1, contacts: [{ address: 'x', name: 'y' }] }))).toMatch(/No valid contacts/);
    expect(bad('x'.repeat(MAX_IMPORT_BYTES + 1))).toMatch(/too large/);
    for (const e of [bad(''), bad('{not json'), bad('x'.repeat(MAX_IMPORT_BYTES + 1))]) expect(e).not.toMatch(/—/);
  });

  test('bad rows and in-file duplicates are counted, not fatal', () => {
    const r = parseContactsImport(JSON.stringify([{ address: A, name: 'Alice' }, { address: A.toUpperCase().replace('0X', '0x'), name: 'dup' }, { address: 'zz', name: 'q' }, { address: B, name: 'Bob' }]), NOW);
    expect(r.ok && r.contacts.map((c) => c.name)).toEqual(['Alice', 'Bob']);
    expect(r.ok && r.invalid).toBe(2);
  });

  test('CSV with and without a header, quoted names', () => {
    expect(parseCsv('a,"b, ""c"""\r\nd,e')).toEqual([['a', 'b, "c"'], ['d', 'e']]);
    const withHeader = parseContactsImport(`name,address\n"Smith, Alice",${A}\nBob,${B}\n`, NOW);
    expect(withHeader.ok && withHeader.contacts.map((c) => c.name)).toEqual(['Smith, Alice', 'Bob']);
    const bare = parseContactsImport(`${A},Alice\n${STELLAR},Stella`, NOW);
    expect(bare.ok && bare.contacts.map((c) => c.address)).toEqual([A_CHECKSUM, STELLAR]);
  });

  test('merge never overwrites a saved name unless asked, and says what happened', () => {
    const existing: Contact[] = [{ address: A_CHECKSUM, name: 'Alice', createdAt: DAY, updatedAt: DAY }, { address: canonicalAddress(B)!.display, name: 'Bob', createdAt: DAY, updatedAt: DAY }];
    const incoming = parseContactsImport(JSON.stringify([
      { address: A, name: 'Alice' }, // same
      { address: B, name: 'Robert' }, // conflict
      { address: STELLAR, name: 'Stella' }, // new
      { address: 'bad', name: 'x' }, // invalid
    ]), NOW);
    if (!incoming.ok) throw new Error('parse');
    const plan = planContactsImport(existing, incoming.contacts);
    expect(plan.added.map((c) => c.name)).toEqual(['Stella']);
    expect(plan.conflicts.map((c) => c.incoming.name)).toEqual(['Robert']);
    expect(plan.unchanged).toBe(1);

    const keep = applyContactsImport(existing, plan, { replaceNames: false, invalid: incoming.invalid, now: NOW });
    expect(keep.list.find((c) => c.address === canonicalAddress(B)!.display)!.name).toBe('Bob');
    expect(importSummary(keep)).toBe('1 added, 3 skipped');

    const replace = applyContactsImport(existing, plan, { replaceNames: true, invalid: incoming.invalid, now: NOW });
    expect(replace.list.find((c) => c.address === canonicalAddress(B)!.display)!.name).toBe('Robert');
    expect(importSummary(replace)).toBe('1 added, 1 renamed, 2 skipped');
  });

  test('an import past the list bound skips the excess', () => {
    const existing: Contact[] = Array.from({ length: MAX_CONTACTS - 1 }, (_, i) => ({ address: canonicalAddress(evmN(i + 1))!.display, name: `n${i}`, createdAt: DAY, updatedAt: DAY }));
    const incoming: Contact[] = [evmN(9001), evmN(9002), evmN(9003)].map((a) => ({ address: canonicalAddress(a)!.display, name: 'new', createdAt: DAY, updatedAt: DAY }));
    const r = applyContactsImport(existing, planContactsImport(existing, incoming), { replaceNames: false, invalid: 0, now: NOW });
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(2);
    expect(r.list).toHaveLength(MAX_CONTACTS);
  });
});
