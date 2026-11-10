import { describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
mock.module('expo-secure-store', () => ({ getItem: () => null, setItem: () => {} }));

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, v); },
  removeItem: (k: string) => { mem.delete(k); },
};

const { contactsStorageKey, readContacts, writeContacts, subscribeContacts, getContactsVersion } = await import('../address-book-store');
const { setContactName } = await import('../address-book-core');

const OWNER_A = '0x1111111111111111111111111111111111111111';
const OWNER_B = '0x2222222222222222222222222222222222222222';
const PAYEE = '0x' + 'c'.repeat(40);

describe('contacts store', () => {
  test('one list per session owner; the key does not spell out the owner', () => {
    const ka = contactsStorageKey(OWNER_A);
    expect(ka).not.toContain(OWNER_A.slice(2, 12));
    expect(ka).toBe(contactsStorageKey(OWNER_A.toUpperCase().replace('0X', '0x')));
    expect(ka).not.toBe(contactsStorageKey(OWNER_B));
    expect(ka.startsWith('ppv2_contacts_v1_')).toBe(true);
  });

  test('write, read back, isolated per owner, listeners notified, cached between writes', () => {
    let calls = 0;
    const off = subscribeContacts(() => { calls++; });
    const v0 = getContactsVersion();
    const { list } = setContactName([], PAYEE, 'Carol', Date.now());
    expect(writeContacts(OWNER_A, list)).toBe(true);
    expect(calls).toBe(1);
    expect(getContactsVersion()).toBe(v0 + 1);
    expect(readContacts(OWNER_A).map((c) => c.name)).toEqual(['Carol']);
    expect(readContacts(OWNER_A)).toBe(readContacts(OWNER_A));
    expect(readContacts(OWNER_B)).toEqual([]);
    expect(readContacts(null)).toEqual([]);
    off();
  });

  test('what lands in storage is address, name and day stamps only', () => {
    const raw = mem.get(contactsStorageKey(OWNER_A))!;
    const rows = JSON.parse(raw) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(['address', 'createdAt', 'name', 'updatedAt']);
    expect((rows[0].createdAt as number) % 86_400_000).toBe(0);
  });

  test('a corrupt stored value reads as empty', () => {
    mem.set(contactsStorageKey(OWNER_B), '{oops');
    writeContacts(OWNER_A, readContacts(OWNER_A)); // bump the version so the cache is dropped
    expect(readContacts(OWNER_B)).toEqual([]);
  });
});
