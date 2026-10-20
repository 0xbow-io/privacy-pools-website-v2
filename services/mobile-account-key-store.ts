import { accountKeyFingerprint, decodeAccountKey } from '@/services/account-key';

/**
 * Account keys imported on the phone, kept in the OS keystore (SecureStore).
 *
 * Layout: one entry per key (`ppv2_ak_key_<id>`, the encoded account key, a
 * few hundred bytes), an index (`ppv2_ak_index_v1`: id, name, address), and
 * the active id (`ppv2_ak_active_v1`). Entries stay well under SecureStore's
 * ~2 KB per-value limit, and the index is capped for the same reason.
 *
 * SecureStore reads of '' mean "no value" (see config/tor.ts deviceStorage),
 * so an empty string is treated as absent everywhere here.
 *
 * Storage is injected so the bun suite can drive it; the app passes
 * expo-secure-store (components/mobile-account-keys-provider.native.tsx).
 */

export type SecureKV = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

export type StoredAccountKey = {
  id: string;
  name: string;
  address: string;
};

/**
 * A row as listed: the index entry plus the fingerprint of its secret
 * (accountKeyFingerprint, the whole identity, not just the address). Computed
 * from the secret on every list, never written to the index, so the index
 * stays small. null when the secret is missing or unreadable.
 */
export type ListedAccountKey = StoredAccountKey & { fingerprint: string | null };

export type AccountKeyList = {
  keys: ListedAccountKey[];
  activeId: string | null;
};

const fingerprintOf = (encoded: string | null): string | null => {
  if (!encoded) return null;
  try {
    return accountKeyFingerprint(decodeAccountKey(encoded));
  } catch {
    return null;
  }
};

export const MAX_STORED_ACCOUNT_KEYS = 12;
export const MAX_ACCOUNT_KEY_NAME = 24;

const INDEX_KEY = 'ppv2_ak_index_v1';
const ACTIVE_KEY = 'ppv2_ak_active_v1';
const ID_RE = /^[0-9a-f]{12}$/;
const entryKey = (id: string) => `ppv2_ak_key_${id}`;

const ADJECTIVES = [
  'Amber', 'Brisk', 'Calm', 'Clever', 'Cosmic', 'Crimson', 'Daring', 'Dusky',
  'Gentle', 'Golden', 'Hidden', 'Jolly', 'Lucky', 'Mellow', 'Misty', 'Nimble',
  'Quiet', 'Rapid', 'Silent', 'Silver', 'Sunny', 'Swift', 'Velvet', 'Wild',
];
const NOUNS = [
  'Badger', 'Comet', 'Cedar', 'Falcon', 'Fern', 'Fox', 'Harbor', 'Heron',
  'Lantern', 'Lynx', 'Maple', 'Meadow', 'Otter', 'Owl', 'Pebble', 'Pine',
  'Raven', 'River', 'Robin', 'Sparrow', 'Tiger', 'Willow', 'Wolf', 'Wren',
];

type RandomFill = (bytes: Uint8Array) => Uint8Array;

function defaultRandom(bytes: Uint8Array): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto;
  if (!c?.getRandomValues) throw new Error('No secure random source.');
  return c.getRandomValues(bytes);
}

function randomInt(max: number, fill: RandomFill): number {
  const buf = new Uint32Array(1);
  const bytes = new Uint8Array(buf.buffer);
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  for (;;) {
    fill(bytes);
    if (buf[0] < limit) return buf[0] % max;
  }
}

function randomId(fill: RandomFill): string {
  const bytes = new Uint8Array(6);
  fill(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomAccountKeyName(taken: Iterable<string>, fill: RandomFill = defaultRandom): string {
  const used = new Set(Array.from(taken, (n) => n.toLowerCase()));
  for (let i = 0; i < 32; i++) {
    const name = `${ADJECTIVES[randomInt(ADJECTIVES.length, fill)]} ${NOUNS[randomInt(NOUNS.length, fill)]}`;
    if (!used.has(name.toLowerCase())) return name;
  }
  for (let n = 2; ; n++) {
    const name = `Key ${n}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

/** Trimmed, control characters removed, at most MAX_ACCOUNT_KEY_NAME. */
export function cleanAccountKeyName(input: string): string {
  return input.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_ACCOUNT_KEY_NAME).trim();
}

/** null = an index is there but unreadable (never treated as "no keys" by a write). */
function parseIndex(raw: string | null): StoredAccountKey[] | null {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { v?: number; keys?: unknown };
    if (parsed?.v !== 1 || !Array.isArray(parsed.keys)) return null;
    return parsed.keys.flatMap((k): StoredAccountKey[] => {
      const e = k as Partial<StoredAccountKey>;
      if (typeof e?.id !== 'string' || !ID_RE.test(e.id)) return [];
      if (typeof e.name !== 'string' || typeof e.address !== 'string') return [];
      return [{ id: e.id, name: cleanAccountKeyName(e.name) || 'Account key', address: e.address }];
    });
  } catch {
    return null;
  }
}

const sameIdentity = (a: string, b: string) => {
  try {
    const x = decodeAccountKey(a);
    const y = decodeAccountKey(b);
    return x.address.toLowerCase() === y.address.toLowerCase()
      && x.signature.toLowerCase() === y.signature.toLowerCase()
      && (x.legacySignature ?? '').toLowerCase() === (y.legacySignature ?? '').toLowerCase();
  } catch {
    return false;
  }
};

export function createAccountKeyStore(kv: SecureKV, fill: RandomFill = defaultRandom) {
  // One write at a time: index read-modify-write must not interleave.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  const read = async (key: string) => {
    const v = await kv.get(key);
    return v ? v : null;
  };
  // A read error (keystore locked, transient failure) throws through: it is
  // never "no keys", or a write would overwrite the index and orphan secrets.
  const readIndex = async () => {
    const keys = parseIndex(await read(INDEX_KEY));
    if (!keys) throw new Error('Saved keys could not be read.');
    return keys;
  };
  const writeIndex = (keys: StoredAccountKey[]) => kv.set(INDEX_KEY, JSON.stringify({
    v: 1,
    keys: keys.map(({ id, name, address }) => ({ id, name, address })),
  }));

  async function list(): Promise<AccountKeyList> {
    const index = await readIndex();
    const keys: ListedAccountKey[] = [];
    for (const k of index) keys.push({ ...k, fingerprint: fingerprintOf(await read(entryKey(k.id))) });
    const active = await read(ACTIVE_KEY);
    return { keys, activeId: active && keys.some((k) => k.id === active) ? active : null };
  }

  /** The encoded account key for `id`, or null when missing or unreadable. */
  async function secret(id: string): Promise<string | null> {
    if (!ID_RE.test(id)) return null;
    const value = await read(entryKey(id));
    if (!value) return null;
    try {
      decodeAccountKey(value);
      return value;
    } catch {
      return null;
    }
  }

  /** Stores (or finds) the key and makes it active. Returns its entry. */
  function add(encoded: string): Promise<ListedAccountKey> {
    return serial(async () => {
      const identity = decodeAccountKey(encoded);
      const value = encoded.trim();
      const fingerprint = accountKeyFingerprint(identity);
      const keys = await readIndex();
      for (const k of keys) {
        if (k.address.toLowerCase() !== identity.address.toLowerCase()) continue;
        const existing = await read(entryKey(k.id));
        if (existing && sameIdentity(existing, value)) {
          // Already saved: same best-effort active write as a new entry below.
          await kv.set(ACTIVE_KEY, k.id).catch(() => undefined);
          return { ...k, fingerprint };
        }
      }
      if (keys.length >= MAX_STORED_ACCOUNT_KEYS) throw new Error('Too many saved keys. Remove one first.');
      let id = randomId(fill);
      while (keys.some((k) => k.id === id)) id = randomId(fill);
      const entry: StoredAccountKey = { id, name: randomAccountKeyName(keys.map((k) => k.name), fill), address: identity.address };
      // Secret first: an index entry never points at nothing.
      await kv.set(entryKey(id), value);
      try {
        await writeIndex([...keys, entry]);
      } catch (err) {
        // No index entry, so no way to reach this secret from the UI: drop it.
        await kv.remove(entryKey(id)).catch(() => undefined);
        throw err;
      }
      // The key is saved and listed either way. A failed active write only
      // means launch will not resume it; the caller signs in with it now.
      await kv.set(ACTIVE_KEY, id).catch(() => undefined);
      return { ...entry, fingerprint };
    });
  }

  function rename(id: string, name: string): Promise<StoredAccountKey> {
    return serial(async () => {
      const clean = cleanAccountKeyName(name);
      if (!clean) throw new Error('Enter a name.');
      const keys = await readIndex();
      const i = keys.findIndex((k) => k.id === id);
      if (i < 0) throw new Error('Key not found.');
      const next = keys.map((k, j) => (j === i ? { ...k, name: clean } : k));
      await writeIndex(next);
      return next[i];
    });
  }

  function remove(id: string): Promise<void> {
    return serial(async () => {
      const keys = await readIndex();
      // Secret first. If that fails the key stays listed (and removable); if
      // the index write then fails, the row stays with no secret behind it,
      // which reads as "could not be read" and removes cleanly on retry.
      // Never the other way round: a hidden row over a live secret.
      if (ID_RE.test(id)) await kv.remove(entryKey(id));
      await writeIndex(keys.filter((k) => k.id !== id));
      // A stale active id pointing at a removed key is ignored by list().
      if ((await read(ACTIVE_KEY)) === id) await kv.remove(ACTIVE_KEY);
    });
  }

  function setActive(id: string | null): Promise<void> {
    return serial(async () => {
      if (id === null) { await kv.remove(ACTIVE_KEY); return; }
      const keys = await readIndex();
      if (!keys.some((k) => k.id === id)) throw new Error('Key not found.');
      await kv.set(ACTIVE_KEY, id);
    });
  }

  return { list, secret, add, rename, remove, setActive };
}

export type AccountKeyStore = ReturnType<typeof createAccountKeyStore>;

/**
 * The saved key the LIVE session is, judged by the session's full identity
 * (accountKeyFingerprint: address + signature + legacy signature), never by
 * the stored active id or the address alone. A key pasted in the wallet modal
 * becomes the session without going through the store, and two keys for one
 * address with different signatures are different accounts.
 * `liveKeyFingerprint` is the session's fingerprint in a key session, else null.
 */
export function keyInUse(list: AccountKeyList, liveKeyFingerprint: string | null | undefined): string | null {
  if (!liveKeyFingerprint) return null;
  // add() dedupes by identity, so a fingerprint names at most one row; prefer
  // the active row anyway if an old store holds a duplicate.
  const matches = list.keys.filter((k) => k.fingerprint === liveKeyFingerprint);
  if (matches.length === 0) return null;
  return (matches.find((k) => k.id === list.activeId) ?? matches[0]).id;
}

/**
 * What the stored active id should become so the next launch resumes the key
 * actually in use. `undefined` = leave it (no key session right now: either
 * not signed in yet, or an explicit Sign Out already cleared it). `null` =
 * the session is a key that is not saved here, so launch resumes nothing.
 */
export function reconcileActiveId(list: AccountKeyList, liveKeyFingerprint: string | null | undefined): string | null | undefined {
  if (!liveKeyFingerprint) return undefined;
  const inUse = keyInUse(list, liveKeyFingerprint);
  return inUse === list.activeId ? undefined : inUse;
}

/**
 * A sign-in interrupted by another key source switching (KeySourceChangedError,
 * `transient: true`) is not a bad key: run it once more. Anything else throws.
 */
export async function retryTransientOnce<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if ((err as { transient?: boolean } | null)?.transient) return run();
    throw err;
  }
}
