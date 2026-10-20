import { describe, expect, test } from 'bun:test';
import { accountKeyFingerprint, encodeAccountKey } from '@/services/account-key';
import {
  MAX_ACCOUNT_KEY_NAME,
  MAX_STORED_ACCOUNT_KEYS,
  cleanAccountKeyName,
  createAccountKeyStore,
  keyInUse,
  randomAccountKeyName,
  reconcileActiveId,
  retryTransientOnce,
  type SecureKV,
} from '@/services/mobile-account-key-store';

describe('which saved key is in use (the live session decides)', () => {
  const addr = `0x${'01'.repeat(20)}` as const;
  const idA = { address: addr, signature: `0x${'aa'.repeat(65)}` as const };
  // Same address, different signature: a different account key.
  const idA2 = { address: addr, signature: `0x${'bb'.repeat(65)}` as const };
  const idB = { address: `0x${'02'.repeat(20)}` as const, signature: `0x${'cc'.repeat(65)}` as const };
  const A = { id: 'aaaaaaaaaaaa', name: 'A', address: addr, fingerprint: accountKeyFingerprint(idA) };
  const A2 = { id: 'cccccccccccc', name: 'A2', address: addr, fingerprint: accountKeyFingerprint(idA2) };
  const B = { id: 'bbbbbbbbbbbb', name: 'B', address: idB.address, fingerprint: accountKeyFingerprint(idB) };

  test('the fingerprint covers the whole identity, case-insensitively', () => {
    expect(A.fingerprint).not.toBe(A2.fingerprint);
    expect(accountKeyFingerprint({ ...idA, legacySignature: `0x${'dd'.repeat(65)}` })).not.toBe(A.fingerprint);
    expect(accountKeyFingerprint({ address: addr.toUpperCase().replace('0X', '0x') as typeof addr, signature: idA.signature.toUpperCase().replace('0X', '0x') as typeof idA.signature })).toBe(A.fingerprint);
    expect(A.fingerprint).toMatch(/^[0-9a-f]{32}$/);
  });

  test('a key pasted in the wallet modal is not shown as the stored active key', () => {
    const list = { keys: [A, B], activeId: A.id };
    const pasted = accountKeyFingerprint({ address: `0x${'09'.repeat(20)}`, signature: `0x${'ee'.repeat(65)}` });
    expect(keyInUse(list, pasted)).toBeNull();
    // Launch must not resume A: the user last used the pasted key.
    expect(reconcileActiveId(list, pasted)).toBeNull();
  });

  test('same address, other signature: the other row is in use, not the active one', () => {
    const list = { keys: [A, A2, B], activeId: A.id };
    expect(keyInUse(list, A2.fingerprint)).toBe(A2.id);
    expect(reconcileActiveId(list, A2.fingerprint)).toBe(A2.id);
    // An unsaved third key for the same address matches neither row.
    const A3 = accountKeyFingerprint({ address: addr, signature: `0x${'ff'.repeat(65)}` });
    expect(keyInUse(list, A3)).toBeNull();
    expect(reconcileActiveId(list, A3)).toBeNull();
  });

  test('pasting a saved key B moves the active id to B', () => {
    const list = { keys: [A, B], activeId: A.id };
    expect(keyInUse(list, B.fingerprint)).toBe(B.id);
    expect(reconcileActiveId(list, B.fingerprint)).toBe(B.id);
  });

  test('no key session: nothing in use, active id left alone', () => {
    const list = { keys: [A, B], activeId: A.id };
    expect(keyInUse(list, null)).toBeNull();
    expect(reconcileActiveId(list, null)).toBeUndefined();
  });

  test('already consistent: no write', () => {
    expect(reconcileActiveId({ keys: [A, B], activeId: A.id }, A.fingerprint)).toBeUndefined();
  });

  test('a row whose secret is unreadable is never in use', () => {
    expect(keyInUse({ keys: [{ ...A, fingerprint: null }], activeId: A.id }, A.fingerprint)).toBeNull();
  });

  test('store: two keys for one address are two rows with their own fingerprints', async () => {
    const store = createAccountKeyStore(memoryKV().kv);
    const a = await store.add(encodeAccountKey(idA));
    const a2 = await store.add(encodeAccountKey(idA2));
    expect(a.id).not.toBe(a2.id);
    const listed = await store.list();
    expect(listed.keys.map((k) => k.fingerprint)).toEqual([accountKeyFingerprint(idA), accountKeyFingerprint(idA2)]);
    expect(keyInUse(listed, accountKeyFingerprint(idA))).toBe(a.id);
  });
});

describe('retryTransientOnce', () => {
  test('retries once on a transient error', async () => {
    let n = 0;
    const out = await retryTransientOnce(async () => {
      n++;
      if (n === 1) throw Object.assign(new Error('key source changed'), { transient: true });
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(n).toBe(2);
  });

  test('does not retry a real failure, and retries only once', async () => {
    let n = 0;
    await expect(retryTransientOnce(async () => { n++; throw new Error('bad key'); })).rejects.toThrow('bad key');
    expect(n).toBe(1);
    n = 0;
    await expect(retryTransientOnce(async () => { n++; throw Object.assign(new Error('again'), { transient: true }); })).rejects.toThrow('again');
    expect(n).toBe(2);
  });
});

/** SecureStore semantics: '' reads back as "no value", names are [A-Za-z0-9._-]. */
function memoryKV() {
  const map = new Map<string, string>();
  const kv: SecureKV = {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => {
      if (!/^[A-Za-z0-9._-]+$/.test(k)) throw new Error(`bad key ${k}`);
      map.set(k, v);
    },
    remove: async (k) => { map.delete(k); },
  };
  return { kv, map };
}

const key = (n: number, legacy = false) => encodeAccountKey({
  address: `0x${n.toString(16).padStart(2, '0').repeat(20)}`,
  signature: `0x${(n + 1).toString(16).padStart(2, '0').repeat(65)}`,
  ...(legacy ? { legacySignature: `0x${'ef'.repeat(65)}` as const } : {}),
});

describe('mobile account key store', () => {
  test('add stores one entry per key, names it, and makes it active', async () => {
    const { kv, map } = memoryKV();
    const store = createAccountKeyStore(kv);
    const a = await store.add(key(1));
    const b = await store.add(key(2, true));
    expect(a.name).toMatch(/^\w+ \w+$/);
    expect(a.name).not.toBe(b.name);
    expect(await store.list()).toEqual({ keys: [a, b], activeId: b.id });
    expect(await store.secret(a.id)).toBe(key(1));
    expect(await store.secret(b.id)).toBe(key(2, true));
    // Every value stays far below SecureStore's ~2 KB limit.
    for (const v of map.values()) expect(v.length).toBeLessThan(1024);
  });

  test('re-importing the same key reuses its entry', async () => {
    const store = createAccountKeyStore(memoryKV().kv);
    const a = await store.add(key(1));
    await store.add(key(2));
    const again = await store.add(` ${key(1)} `);
    expect(again).toEqual(a);
    const listed = await store.list();
    expect(listed.keys).toHaveLength(2);
    expect(listed.activeId).toBe(a.id);
  });

  test('rename, switch, remove', async () => {
    const store = createAccountKeyStore(memoryKV().kv);
    const a = await store.add(key(1));
    const b = await store.add(key(2));
    expect((await store.rename(a.id, '  Savings\n ')).name).toBe('Savings');
    await expect(store.rename(a.id, '   ')).rejects.toThrow('Enter a name');
    await store.setActive(a.id);
    expect((await store.list()).activeId).toBe(a.id);
    await expect(store.setActive('000000000000')).rejects.toThrow();
    await store.remove(a.id);
    expect(await store.secret(a.id)).toBeNull();
    expect(await store.list()).toEqual({ keys: [b], activeId: null });
    await store.setActive(null);
    expect((await store.list()).activeId).toBeNull();
  });

  test('invalid keys are refused and the cap holds', async () => {
    const store = createAccountKeyStore(memoryKV().kv);
    await expect(store.add('not a key')).rejects.toThrow();
    for (let i = 0; i < MAX_STORED_ACCOUNT_KEYS; i++) await store.add(key(i + 10));
    await expect(store.add(key(200))).rejects.toThrow('Too many');
  });

  test('concurrent adds do not lose index entries', async () => {
    const store = createAccountKeyStore(memoryKV().kv);
    await Promise.all([1, 2, 3, 4].map((n) => store.add(key(n * 3))));
    expect((await store.list()).keys).toHaveLength(4);
  });

  test("an empty string reads as absent, like SecureStore's '' convention", async () => {
    const { kv, map } = memoryKV();
    const store = createAccountKeyStore(kv);
    const a = await store.add(key(1));
    map.set(`ppv2_ak_key_${a.id}`, '');
    map.set('ppv2_ak_active_v1', '');
    expect(await store.secret(a.id)).toBeNull();
    expect((await store.list()).activeId).toBeNull();
    map.set('ppv2_ak_index_v1', '');
    expect((await store.list()).keys).toEqual([]);
  });

  test('a failed read is an error, never an empty store', async () => {
    const { kv, map } = memoryKV();
    const store = createAccountKeyStore(kv);
    const a = await store.add(key(1));
    const flaky: SecureKV = { ...kv, get: async () => { throw new Error('keystore locked'); } };
    const locked = createAccountKeyStore(flaky);
    await expect(locked.list()).rejects.toThrow('keystore locked');
    await expect(locked.add(key(2))).rejects.toThrow('keystore locked');
    // A corrupt index is not "no keys" either: writes refuse instead of
    // overwriting it and orphaning the secrets it points at.
    map.set('ppv2_ak_index_v1', '{not json');
    await expect(store.add(key(2))).rejects.toThrow('could not be read');
    expect(map.get(`ppv2_ak_key_${a.id}`)).toBe(key(1));
  });

  test('add: a failed index write leaves no orphan secret', async () => {
    const { kv, map } = memoryKV();
    const store = createAccountKeyStore({
      ...kv,
      set: async (k, v) => { if (k === 'ppv2_ak_index_v1') throw new Error('disk full'); return kv.set(k, v); },
    });
    await expect(store.add(key(1))).rejects.toThrow('disk full');
    expect([...map.keys()].filter((k) => k.startsWith('ppv2_ak_key_'))).toEqual([]);
  });

  test('add: a failed active write still saves and lists the key', async () => {
    const { kv } = memoryKV();
    const store = createAccountKeyStore({
      ...kv,
      set: async (k, v) => { if (k === 'ppv2_ak_active_v1') throw new Error('flaky'); return kv.set(k, v); },
    });
    const a = await store.add(key(1));
    expect(await store.list()).toEqual({ keys: [a], activeId: null });
    expect(await store.secret(a.id)).toBe(key(1));
    // Re-importing the same saved key takes the same path: no rejection.
    expect(await store.add(key(1))).toEqual(a);
    expect((await store.list()).keys).toEqual([a]);
  });

  test('remove: a failed secret delete keeps the row, so nothing is hidden over a live secret', async () => {
    const { kv, map } = memoryKV();
    let failDelete = true;
    const store = createAccountKeyStore({
      ...kv,
      remove: async (k) => { if (failDelete && k.startsWith('ppv2_ak_key_')) throw new Error('nope'); return kv.remove(k); },
    });
    const a = await store.add(key(1));
    await expect(store.remove(a.id)).rejects.toThrow('nope');
    expect((await store.list()).keys).toEqual([a]);
    failDelete = false;
    await store.remove(a.id);
    expect((await store.list()).keys).toEqual([]);
    expect(map.has(`ppv2_ak_key_${a.id}`)).toBe(false);
  });

  test('remove: a failed index write leaves a row with no secret, removable on retry', async () => {
    const { kv } = memoryKV();
    let failIndex = false;
    const store = createAccountKeyStore({
      ...kv,
      set: async (k, v) => { if (failIndex && k === 'ppv2_ak_index_v1') throw new Error('nope'); return kv.set(k, v); },
    });
    const a = await store.add(key(1));
    failIndex = true;
    await expect(store.remove(a.id)).rejects.toThrow('nope');
    expect(await store.secret(a.id)).toBeNull();
    failIndex = false;
    await store.remove(a.id);
    expect(await store.list()).toEqual({ keys: [], activeId: null });
  });

  test('names', () => {
    expect(cleanAccountKeyName('a'.repeat(60))).toHaveLength(MAX_ACCOUNT_KEY_NAME);
    expect(cleanAccountKeyName(' a\u0000b ')).toBe('ab');
    // Falls back once every random name is taken.
    const zeros = (b: Uint8Array) => b.fill(0);
    expect(randomAccountKeyName([], zeros)).toBe('Amber Badger');
    expect(randomAccountKeyName(['amber badger'], zeros)).toBe('Key 2');
    expect(randomAccountKeyName(['Amber Badger', 'Key 2'], zeros)).toBe('Key 3');
  });
});
