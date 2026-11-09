import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const { identityStatusFromRegistry, ownRegistrationRefusal, REGISTRATION_INCOMPATIBLE_MESSAGE, REGISTRATION_UNCONFIRMED_MESSAGE } = await import('@/services/keystore-identity-status');
const cache = await import('@/services/nullifying-key-hash-cache');
const policy = await import('@/services/egress-policy');
const { ASP_URL } = await import('@/config/env');
const sync = (chainId: number, keystore?: string, entrypoint?: string) =>
  cache.syncNullifyingKeyHashes(chainId, keystore, send, async () => entrypoint);

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

describe('ownRegistrationRefusal (the last check before a deposit)', () => {
  const view = { nullifyingKeyHash: null, nullifyingFresh: true, viewingKey: null, viewingFresh: true };
  const active = BigInt(HASH).toString();

  test('a fresh-looking registry miss next to a registered chain refuses the deposit', () => {
    // Registered under P1 on another device minutes ago, the local copy has not
    // caught up, and this session holds P2. The registry says 'unregistered',
    // the live nonzero read says registered: depositing would mint a note P2
    // can never spend.
    const status = identityStatusFromRegistry(view, active, VK);
    expect(status).toBe('unregistered');
    expect(ownRegistrationRefusal(status, true)).toBe(REGISTRATION_UNCONFIRMED_MESSAGE);
    expect(REGISTRATION_UNCONFIRMED_MESSAGE).toContain('Nothing was sent');
  });

  test('an unregistered chain goes to registration, a matching one goes ahead', () => {
    expect(ownRegistrationRefusal('unregistered', false)).toBeNull();
    expect(ownRegistrationRefusal('compatible', true)).toBeNull();
    expect(ownRegistrationRefusal('partial', true)).toBeNull();
  });

  test('another unlock or an unanswered registry never goes ahead on a registered chain', () => {
    expect(ownRegistrationRefusal('incompatible', true)).not.toBeNull();
    expect(ownRegistrationRefusal('incompatible', false)).not.toBeNull();
    expect(ownRegistrationRefusal('unknown', true)).not.toBeNull();
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
    const outcome = await sync(1);
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
    expect(await sync(1)).toEqual({ ok: false, reason: 'not-deployed' });
    expect(cache.isNullifyingKeyRegistryFresh(1)).toBe(false);
    // Short-circuits afterwards: no repeated requests this session.
    await sync(1);
    expect(sent.length).toBe(1);
  });

  test('scopes the pull to the configured pool and never caches another keystore', async () => {
    const KEYSTORE = '0x6d264acb9c3a7a3105c29470afe2f5f1ec203c73';
    const LEGACY_KEYSTORE = '0x5b8883a2f8339560d8ebfeaabf93ce4e7056c4ca';
    const ENTRYPOINT = '0xEB3E3961008952348445513E418AD6F43C23CA9A';
    respond = () => json({ entries: [{ id: '1', account: BOB, nullifyingKeyHash: HASH, lastUpdatedBlock: '0x1' }], keystore: KEYSTORE, lastSyncedId: '1', hasMore: false });
    expect((await sync(11155111, KEYSTORE, ENTRYPOINT)).ok).toBe(true);
    const url = `${ASP_URL}/11155111/public/nullifying-key-hashes?sinceId=0&entrypoint=${ENTRYPOINT.toLowerCase()}`;
    expect(sent.map((s) => s.url)).toEqual([url]);
    expect(policy.checkAspRequest({ method: 'GET', url: url.slice(ASP_URL.length), headers: { accept: 'application/json' } }).allowed).toBe(true);
    expect(cache.getCachedNullifyingKeyHash(11155111, BOB, KEYSTORE)).toBe(HASH);
    // The server resolved a different keystore than the scope asked for.
    expect(await sync(11155111, LEGACY_KEYSTORE, ENTRYPOINT)).toEqual({ ok: false, reason: 'not-deployed' });
    expect(cache.getCachedNullifyingKeyHash(11155111, BOB, LEGACY_KEYSTORE)).toBeNull();
  });

  test('a malformed body is a parse failure', async () => {
    respond = () => json({ keys: [] });
    expect(await sync(1)).toMatchObject({ ok: false, reason: 'parse' });
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
    expect(await sync(1)).toEqual({ ok: false, reason: 'parse' });
    respond = () => json({ entries: [], lastSyncedId: '4', hasMore: false });
    await sync(1);
    expect(sent[1].url.endsWith('sinceId=0')).toBe(true);
  });

  test('page progress is kept when a tick runs out of pages', async () => {
    let n = 0;
    respond = () => { n += 1; return json({ entries: [], lastSyncedId: String(n), hasMore: true }); };
    expect((await sync(1)).ok).toBe(false);
    sent.length = 0;
    respond = () => json({ entries: [], lastSyncedId: String(n), hasMore: false });
    await sync(1);
    expect(sent[0].url.endsWith(`sinceId=${n}`)).toBe(true);
  });

  test('our own confirmed registration answers a registry miss, never a served entry', async () => {
    respond = () => json({ entries: [{ id: '1', account: BOB, nullifyingKeyHash: HASH, lastUpdatedBlock: '0x1' }], lastSyncedId: '1', hasMore: false });
    await sync(1);
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

describe('an "already registered" answer is only ours when the registry hash is this unlock (review of #34)', () => {
  // SDK 1.0.2 prepareRegisterKeystore() says alreadyRegistered for ANY auth
  // policy. The scenario: registered under P1 on the phone, signed in with P2
  // on the laptop, pressed Register. The guard compares the registry's hash
  // with the session's own expected hash (registration.nullifyingKeyHash).
  const MINE = `0x${'11'.repeat(32)}`;
  const THEIRS = `0x${'22'.repeat(32)}`;
  const already = { alreadyRegistered: true, keystoreCalldata: null, viewingKeyCalldata: null, nullifyingKeyHash: MINE };
  const viewingKeyOnly = { alreadyRegistered: false, keystoreCalldata: null, viewingKeyCalldata: { to: '0x1', data: '0x', value: 0 }, nullifyingKeyHash: MINE };
  const serve = async (entries: { account: string; hash: string }[]) => {
    cache.resetNullifyingKeyHashCacheForTests();
    try { localStorage.clear(); } catch { /* no DOM storage under bun */ }
    respond = () => json({
      entries: entries.map((e, i) => ({ id: String(i + 1), account: e.account, nullifyingKeyHash: e.hash, lastUpdatedBlock: '0x1' })),
      lastSyncedId: String(entries.length || 1),
      hasMore: false,
    });
    await sync(1);
    sent.length = 0;
  };

  test('another unlock: the registry hash differs from the session hash, refused', async () => {
    await serve([{ account: ALICE, hash: THEIRS }]);
    expect(cache.alreadySetRegistrationRefusal(1, ALICE, undefined, already)).toBe(REGISTRATION_INCOMPATIBLE_MESSAGE);
    expect(cache.alreadySetRegistrationRefusal(1, ALICE, undefined, viewingKeyOnly)).toBe(REGISTRATION_INCOMPATIBLE_MESSAGE);
    // A confirmed-registration record cannot turn another unlock's hash into ours.
    cache.recordOwnRegistration(1, ALICE, undefined, MINE, VK);
    const view = cache.readRegistryView(1, ALICE);
    expect(view.nullifyingKeyHash).toBe(`0x${'22'.repeat(32)}`);
    expect(view.viewingKey).toBeNull();
    const status = identityStatusFromRegistry(view, BigInt(MINE).toString(), VK);
    expect(status).toBe('incompatible');
    expect(ownRegistrationRefusal(status, true)).toBe(REGISTRATION_INCOMPATIBLE_MESSAGE);
    expect(sent.length).toBe(0);
  });

  test('our own unlock: the registry hash equals the session hash, confirmed', async () => {
    await serve([{ account: ALICE, hash: MINE }]);
    expect(cache.alreadySetRegistrationRefusal(1, ALICE, undefined, already)).toBeNull();
    expect(cache.alreadySetRegistrationRefusal(1, ALICE, undefined, viewingKeyOnly)).toBeNull();
    expect(sent.length).toBe(0);
  });

  test('no registry hash for the account: unconfirmed, never complete', async () => {
    await serve([{ account: BOB, hash: THEIRS }]);
    expect(cache.alreadySetRegistrationRefusal(1, ALICE, undefined, already)).toBe(REGISTRATION_UNCONFIRMED_MESSAGE);
    expect(cache.alreadySetRegistrationRefusal(1, '', undefined, already)).toBe(REGISTRATION_UNCONFIRMED_MESSAGE);
  });

  test('a confirmed receipt record stands in until the ASP serves the entry', async () => {
    await serve([{ account: BOB, hash: THEIRS }]);
    cache.recordOwnRegistration(1, ALICE, undefined, MINE, null);
    expect(cache.alreadySetRegistrationRefusal(1, ALICE, undefined, already)).toBeNull();
  });

  test('a plan that still sends the auth leg needs no check', async () => {
    await serve([]);
    const fresh = { alreadyRegistered: false, keystoreCalldata: { to: '0x1', data: '0x', value: 0 }, nullifyingKeyHash: MINE };
    expect(cache.alreadySetRegistrationRefusal(1, ALICE, undefined, fresh)).toBeNull();
  });

  test('every already-registered path checks before marking complete', () => {
    const src = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8');
    const modal = src('components/keystore-registration-modal-provider.tsx');
    // The check runs before finishAlreadyRegistered can be reached.
    expect(modal.indexOf('refuseIfNotOurs(registration);')).toBeGreaterThan(-1);
    expect(modal.indexOf('refuseIfNotOurs(registration);')).toBeLessThan(modal.indexOf('const finishAlreadyRegistered = async'));
    expect(modal).toContain('refuseIfNotOurs({ ...fresh, keystoreCalldata: null });');
    const importer = src('hooks/use-note-import.ts');
    expect(importer.match(/ownRegistrationResultRefusal\(chainId, sessionAddress, registration\)/g)?.length).toBe(3);
    expect(importer).not.toContain("if (registration.alreadyRegistered) setReceiveSetup(");
    const pay = src('components/payment-request-modal-provider.tsx');
    expect(pay).toContain('const notOurs = ownRegistrationResultRefusal(request.chainId, address, registration);');
    expect(pay).toContain("if (!notOurs) setReceiveSetup(address, request.chainId, 'complete', 'onchain');");
    expect(src('hooks/use-publish-viewing-key.ts')).toContain('ownRegistrationResultRefusal(chainId, sessionAddress ?? address, registration)');
  });
});
