import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
mock.module('expo-secure-store', () => ({ getItem: () => null, setItem: () => undefined, deleteItemAsync: async () => undefined }));

type Sent = { url: string };
const sent: Sent[] = [];
let respond: (url: string) => Response = () => new Response('{}', { status: 500 });
const send = (async (_party: string, _base: string, url: string) => {
  sent.push({ url });
  return respond(url);
}) as never;

const { identityStatusFromRegistry } = await import('@/services/keystore-identity-status');
const cache = await import('@/services/nullifying-key-hash-cache');
const policy = await import('@/services/egress-policy');
const { ASP_URL } = await import('@/config/env');

const ALICE = '0x00000000000000000000000000000000000a11ce';
const BOB = '0x0000000000000000000000000000000000000b0b';
const HASH = `0x${'ab'.repeat(32)}`;
const VK = `0x${'cd'.repeat(32)}`;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('identityStatusFromRegistry', () => {
  const view = { nullifyingKeyHash: HASH, nullifyingFresh: true, viewingKey: VK, viewingFresh: true };
  const active = BigInt(HASH).toString();

  test('compatible only when both registries are current and match', () => {
    expect(identityStatusFromRegistry(view, active, VK.toUpperCase().replace('0X', '0x'))).toBe('compatible');
    expect(identityStatusFromRegistry({ ...view, viewingFresh: false }, active, VK)).toBe('unknown');
  });

  test('a write-once hash answers incompatible even from a stale copy', () => {
    expect(identityStatusFromRegistry({ ...view, nullifyingFresh: false }, '1', VK)).toBe('incompatible');
  });

  test('a miss is unregistered only when the registry is current', () => {
    expect(identityStatusFromRegistry({ ...view, nullifyingKeyHash: null }, active, VK)).toBe('unregistered');
    expect(identityStatusFromRegistry({ ...view, nullifyingKeyHash: null, nullifyingFresh: false }, active, VK)).toBe('unknown');
  });

  test('partial on a missing or different viewing key', () => {
    expect(identityStatusFromRegistry({ ...view, viewingKey: null }, active, VK)).toBe('partial');
    expect(identityStatusFromRegistry({ ...view, viewingKey: `0x${'0'.repeat(64)}` }, active, VK)).toBe('partial');
    expect(identityStatusFromRegistry(view, active, `0x${'ef'.repeat(32)}`)).toBe('partial');
  });
});

describe('nullifying-key-hash cache', () => {
  beforeEach(() => {
    sent.length = 0;
    cache.resetNullifyingKeyHashCacheForTests();
    try { localStorage.clear(); } catch { /* no DOM storage under bun */ }
  });

  test('pages from the server cursor, carries no account, and passes the egress policy', async () => {
    respond = (url) => new URL(url).searchParams.get('sinceId') === '0'
      ? json({ entries: [{ id: '3', account: ALICE.toUpperCase().replace('0X', '0x'), nullifyingKeyHash: '255', lastUpdatedBlock: '0x1' }], lastSyncedId: '3', hasMore: true })
      : json({ entries: [{ id: '9', account: BOB, nullifyingKeyHash: HASH, lastUpdatedBlock: '0x2' }], lastSyncedId: '9', hasMore: false });
    expect(cache.isNullifyingKeyRegistryFresh(1)).toBe(false);
    const outcome = await cache.syncNullifyingKeyHashes(1, undefined, send);
    expect(outcome).toEqual({ ok: true, appliedEntries: 2, lastSyncedId: '9' });
    expect(sent.map((s) => s.url)).toEqual([
      `${ASP_URL}/1/public/nullifying-key-hashes?sinceId=0`,
      `${ASP_URL}/1/public/nullifying-key-hashes?sinceId=3`,
    ]);
    for (const { url } of sent) {
      expect(url.toLowerCase()).not.toContain(ALICE.slice(2));
      const path = url.slice(ASP_URL.length);
      expect(policy.checkAspRequest({ method: 'GET', url: path, headers: { accept: 'application/json' } }).allowed).toBe(true);
    }
    expect(cache.getCachedNullifyingKeyHash(1, ALICE)).toBe(`0x${'ff'.padStart(64, '0')}`);
    expect(cache.getCachedNullifyingKeyHash(1, BOB)).toBe(HASH);
    expect(cache.isNullifyingKeyRegistryFresh(1)).toBe(true);
    expect(cache.isNullifyingKeyRegistryFresh(1, undefined, Date.now() + cache.NULLIFYING_KEY_HASH_MAX_AGE_MS + 1)).toBe(false);
  });

  test('an ASP without the feed leaves the registry stale, never fresh', async () => {
    respond = () => new Response('not found', { status: 404 });
    expect(await cache.syncNullifyingKeyHashes(1, undefined, send)).toEqual({ ok: false, reason: 'not-deployed' });
    expect(cache.isNullifyingKeyRegistryFresh(1)).toBe(false);
    // Short-circuits afterwards: no repeated requests this session.
    await cache.syncNullifyingKeyHashes(1, undefined, send);
    expect(sent.length).toBe(1);
  });

  test('a malformed body is a parse failure', async () => {
    respond = () => json({ keys: [] });
    expect(await cache.syncNullifyingKeyHashes(1, undefined, send)).toMatchObject({ ok: false, reason: 'parse' });
    expect(cache.isNullifyingKeyRegistryFresh(1)).toBe(false);
  });
});

describe('review fixes', () => {
  beforeEach(() => {
    sent.length = 0;
    cache.resetNullifyingKeyHashCacheForTests();
    try { localStorage.clear(); } catch { /* no DOM storage under bun */ }
  });

  test('a malformed viewing-key entry is unknown, not partial', () => {
    const view = { nullifyingKeyHash: HASH, nullifyingFresh: true, viewingKey: 'not-hex', viewingFresh: true };
    expect(identityStatusFromRegistry(view, BigInt(HASH).toString(), VK)).toBe('unknown');
  });

  test('a malformed hash fails the sync without advancing the cursor', async () => {
    respond = () => json({ entries: [{ id: '4', account: ALICE, nullifyingKeyHash: 'zz', lastUpdatedBlock: '0x1' }], lastSyncedId: '4', hasMore: false });
    expect(await cache.syncNullifyingKeyHashes(1, undefined, send)).toEqual({ ok: false, reason: 'parse' });
    respond = () => json({ entries: [], lastSyncedId: '4', hasMore: false });
    await cache.syncNullifyingKeyHashes(1, undefined, send);
    expect(sent[1].url.endsWith('sinceId=0')).toBe(true);
  });

  test('page progress is kept when a tick runs out of pages', async () => {
    let n = 0;
    respond = () => { n += 1; return json({ entries: [], lastSyncedId: String(n), hasMore: true }); };
    expect((await cache.syncNullifyingKeyHashes(1, undefined, send)).ok).toBe(false);
    sent.length = 0;
    respond = () => json({ entries: [], lastSyncedId: String(n), hasMore: false });
    await cache.syncNullifyingKeyHashes(1, undefined, send);
    expect(sent[0].url.endsWith(`sinceId=${n}`)).toBe(true);
  });

  test('our own confirmed registration answers a registry miss, never a served entry', async () => {
    respond = () => json({ entries: [{ id: '1', account: BOB, nullifyingKeyHash: HASH, lastUpdatedBlock: '0x1' }], lastSyncedId: '1', hasMore: false });
    await cache.syncNullifyingKeyHashes(1, undefined, send);
    const mine = `0x${'11'.repeat(32)}`;
    cache.recordOwnRegistration(1, ALICE, undefined, mine, null);
    cache.recordOwnRegistration(1, BOB, undefined, mine, null);
    expect(cache.readRegistryView(1, ALICE).nullifyingKeyHash).toBe(mine);
    expect(cache.readRegistryView(1, BOB).nullifyingKeyHash).toBe(HASH);
  });

  test('a write waits for the grid sync instead of fetching, bounded', async () => {
    expect(await cache.awaitKeystoreRegistries(1, undefined, 10)).toBe(false);
    expect(sent.length).toBe(0);
  });
});
