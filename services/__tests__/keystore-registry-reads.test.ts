import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
mock.module('expo-secure-store', () => ({ getItem: () => null, setItem: () => undefined, deleteItemAsync: async () => undefined }));

// bun has no DOM storage: a Map-backed one lets the registries' persisted copy be seeded.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};

const { envScopedStorageKey } = await import('@/config/app-environment');
const cache = await import('@/services/nullifying-key-hash-cache');
const { routeOwnKeystoreReads } = await import('@/services/keystore-registry-reads');
const { confirmedRegistration, onConfirmedRegistration } = await import('@/services/keystore-registry-events');
const { lookupOwnViewingKey } = await import('@/services/keystore-scope');
const { identityStatusFromRegistry, ownRegistrationRefusal, REGISTRATION_UNCONFIRMED_MESSAGE } = await import('@/services/keystore-identity-status');
const { REGISTRY_SYNCING_MESSAGE } = cache;

const CHAIN = 1;
const OWNER = '0x00000000000000000000000000000000000a11ce';
const RECIPIENT = '0x0000000000000000000000000000000000000b0b';
const MINE = `0x${'11'.repeat(32)}`;
const VK = `0x${'cd'.repeat(32)}`;
const ZERO = 0n;

const { keystoreScopeAddress } = await import('@/services/keystore-scope');
const SCOPED = keystoreScopeAddress(CHAIN);
/** Storage scopes: the chain alone (these tests) and the chain's keystore (the app's lookups). */
const scopes = [String(CHAIN), ...(SCOPED ? [`${CHAIN}_${SCOPED.toLowerCase()}`] : [])];

/** A current copy of both registries, as the grid leaves them. */
function seedCurrentRegistries(nullifying: Record<string, string>, viewing: Record<string, string>) {
  for (const scope of scopes) {
    store.set(envScopedStorageKey(`ppv2_nullifying_key_hashes_v1_${scope}`), JSON.stringify({ byAccount: nullifying, lastSyncedId: '1', lastSyncedAt: Date.now() }));
    store.set(envScopedStorageKey(`ppv2_viewing_keys_v1_${scope}`), JSON.stringify({ byAccount: viewing, lastSyncedId: '1', lastSyncedAt: Date.now(), lastFullSyncedAt: Date.now() }));
  }
}

/** The chain's keystore as the SDK sees it, counting every account-keyed read. */
function fakeChain(answers: { hash?: string; viewingKey?: string } = {}) {
  const calls: { method: string; account: string }[] = [];
  const interactor = {
    getNullifyingKeyHash: async (account: string) => { calls.push({ method: 'getNullifyingKeyHash', account }); return answers.hash ?? `0x${'0'.repeat(64)}`; },
    getViewingKey: async (account: string) => { calls.push({ method: 'getViewingKey', account }); return answers.viewingKey ?? `0x${'0'.repeat(64)}`; },
    getKeystoreLeaves: async () => [],
  };
  return { interactor, calls };
}

// The SDK's own reads of the session account (PoolSessionKeystore):
// isKeystoreRegisteredOnChain -> getNullifyingKeyHash, isViewingKeySet -> getViewingKey.
const sdkIsRegistered = async (i: { getNullifyingKeyHash: (a: string) => Promise<unknown> }) => BigInt((await i.getNullifyingKeyHash(OWNER)) as string) !== ZERO;
const sdkIsViewingKeySet = async (i: { getViewingKey: (a: string) => Promise<unknown> }) => BigInt((await i.getViewingKey(OWNER)) as string) !== ZERO;

beforeEach(() => {
  store.clear();
  cache.resetNullifyingKeyHashCacheForTests();
});

describe('own-account reads never reach the chain when the registries answer', () => {
  test('hit: registered, with its viewing key, zero chain calls', async () => {
    seedCurrentRegistries({ [OWNER]: MINE }, { [OWNER]: VK });
    const { interactor, calls } = fakeChain({ hash: `0x${'ff'.repeat(32)}` });
    routeOwnKeystoreReads(interactor, { chainId: CHAIN, ownerAddress: OWNER });
    expect(await sdkIsRegistered(interactor)).toBe(true);
    expect(await sdkIsViewingKeySet(interactor)).toBe(true);
    expect(await interactor.getNullifyingKeyHash(OWNER.toUpperCase().replace('0X', '0x'))).toBe(MINE);
    expect(calls).toEqual([]);
  });

  test('current registries with no entry: unregistered (zero), zero chain calls', async () => {
    seedCurrentRegistries({}, {});
    const { interactor, calls } = fakeChain({ hash: MINE });
    routeOwnKeystoreReads(interactor, { chainId: CHAIN, ownerAddress: OWNER });
    expect(await sdkIsRegistered(interactor)).toBe(false);
    expect(await sdkIsViewingKeySet(interactor)).toBe(false);
    expect(calls).toEqual([]);
  });

  test('missing data refuses both reads without asking even a healthy RPC', async () => {
    const { interactor, calls } = fakeChain({ hash: MINE, viewingKey: VK });
    routeOwnKeystoreReads(interactor, { chainId: CHAIN, ownerAddress: OWNER });
    await expect(sdkIsRegistered(interactor)).rejects.toThrow(REGISTRY_SYNCING_MESSAGE);
    await expect(sdkIsViewingKeySet(interactor)).rejects.toThrow(REGISTRY_SYNCING_MESSAGE);
    expect(calls).toEqual([]);
  });

  test('missing data never becomes unregistered from an RPC zero answer', async () => {
    const { interactor, calls } = fakeChain();
    routeOwnKeystoreReads(interactor, { chainId: CHAIN, ownerAddress: OWNER });
    await expect(sdkIsRegistered(interactor)).rejects.toThrow(REGISTRY_SYNCING_MESSAGE);
    expect(calls).toEqual([]);
  });

  test('a stale viewing-key hit cannot answer because keys can rotate', async () => {
    store.set(envScopedStorageKey(`ppv2_viewing_keys_v1_${CHAIN}`), JSON.stringify({
      byAccount: { [OWNER]: VK }, lastSyncedId: '1',
      lastSyncedAt: Date.now() - 24 * 3600_000, lastFullSyncedAt: Date.now() - 24 * 3600_000,
    }));
    const { interactor, calls } = fakeChain({ viewingKey: VK });
    routeOwnKeystoreReads(interactor, { chainId: CHAIN, ownerAddress: OWNER });
    await expect(sdkIsViewingKeySet(interactor)).rejects.toThrow(REGISTRY_SYNCING_MESSAGE);
    expect(calls).toEqual([]);
  });

  test('a cold registry recovers after the background bulk feed seeds it', async () => {
    const { interactor, calls } = fakeChain();
    routeOwnKeystoreReads(interactor, { chainId: CHAIN, ownerAddress: OWNER });
    await expect(sdkIsRegistered(interactor)).rejects.toThrow(REGISTRY_SYNCING_MESSAGE);
    const outcome = await cache.syncNullifyingKeyHashes(CHAIN, undefined, async () => new Response(JSON.stringify({
      entries: [{ account: OWNER, nullifyingKeyHash: MINE }], lastSyncedId: '1', hasMore: false,
    })), async () => undefined);
    expect(outcome.ok).toBe(true);
    expect(await sdkIsRegistered(interactor)).toBe(true);
    expect(calls).toEqual([]);
  });

  test('a stale registry still answers a write-once hash hit, but not a miss', async () => {
    store.set(envScopedStorageKey(`ppv2_nullifying_key_hashes_v1_${CHAIN}`), JSON.stringify({ byAccount: { [OWNER]: MINE }, lastSyncedId: '1', lastSyncedAt: Date.now() - 24 * 3600_000 }));
    const { interactor, calls } = fakeChain();
    routeOwnKeystoreReads(interactor, { chainId: CHAIN, ownerAddress: OWNER });
    expect(await sdkIsRegistered(interactor)).toBe(true);
    await interactor.getNullifyingKeyHash(RECIPIENT.replace('b0b', 'c0c'));
    expect(calls.map((c) => c.account)).toEqual([RECIPIENT.replace('b0b', 'c0c')]);
  });
});

describe('a registration confirmed by a receipt lets register-then-deposit proceed before the ASP indexes it', () => {
  test('confirmed record answers the SDK reads and the deposit identity check, no chain call', async () => {
    seedCurrentRegistries({}, {});
    const { interactor, calls } = fakeChain();
    routeOwnKeystoreReads(interactor, { chainId: CHAIN, ownerAddress: OWNER });
    expect(await sdkIsRegistered(interactor)).toBe(false);
    // The registration receipt came back successful: what the SDK provider records.
    cache.recordOwnRegistration(CHAIN, OWNER, undefined, MINE, VK);
    expect(await sdkIsRegistered(interactor)).toBe(true);
    expect(await sdkIsViewingKeySet(interactor)).toBe(true);
    const status = identityStatusFromRegistry(cache.readRegistryView(CHAIN, OWNER), BigInt(MINE).toString(), VK);
    expect(status).toBe('compatible');
    expect(ownRegistrationRefusal(status, true)).toBeNull();
    expect(calls).toEqual([]);
  });

  test('an auth-only receipt (relayed registration) registers but leaves the viewing key unset', async () => {
    seedCurrentRegistries({}, {});
    const { interactor } = fakeChain();
    routeOwnKeystoreReads(interactor, { chainId: CHAIN, ownerAddress: OWNER });
    cache.recordOwnRegistration(CHAIN, OWNER, undefined, MINE, null);
    expect(await sdkIsRegistered(interactor)).toBe(true);
    expect(await sdkIsViewingKeySet(interactor)).toBe(false);
  });

  test('without a confirmed receipt nothing is recorded, and a registry miss next to a registered chain refuses', () => {
    seedCurrentRegistries({}, {});
    const status = identityStatusFromRegistry(cache.readRegistryView(CHAIN, OWNER), BigInt(MINE).toString(), VK);
    expect(status).toBe('unregistered');
    expect(ownRegistrationRefusal(status, true)).toBe(REGISTRATION_UNCONFIRMED_MESSAGE);
  });

  test('the receipt event reaches listeners and only when a flow confirms one', () => {
    const seen: unknown[] = [];
    const off = onConfirmedRegistration((e) => seen.push(e));
    confirmedRegistration(OWNER, CHAIN, true);
    confirmedRegistration(null, CHAIN, true);
    off();
    confirmedRegistration(OWNER, CHAIN, false);
    expect(seen).toEqual([{ address: OWNER, chainId: CHAIN, viewingKey: true }]);
  });

  test('every receipt-confirming flow emits the event after the receipt, and the provider no longer records on a leg merely sent', () => {
    const src = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8');
    const modal = src('components/keystore-registration-modal-provider.tsx');
    expect(modal.indexOf("vkReceipt.status !== 'success'")).toBeLessThan(modal.indexOf('confirmedRegistration(sessionAddress ?? address, chainId, true);'));
    expect(src('hooks/use-publish-viewing-key.ts').indexOf("receipt.status !== 'success'")).toBeLessThan(src('hooks/use-publish-viewing-key.ts').indexOf('confirmedRegistration('));
    const gasless = src('hooks/use-gasless-registration.ts');
    expect(gasless.indexOf('could not be confirmed')).toBeLessThan(gasless.indexOf('confirmedRegistration('));
    const pay = src('components/payment-request-modal-provider.tsx');
    expect(pay.indexOf("'Keystore registration')")).toBeLessThan(pay.indexOf('confirmedRegistration(address, request.chainId, false)'));
    expect(src('hooks/use-note-import.ts')).toContain('confirmedRegistration(');
    expect(src('components/withdraw-modal-provider.tsx')).toContain('confirmedRegistration(connectedAddress, chainId, false);');
    const provider = src('components/sdk-provider.tsx');
    expect(provider).toContain('onConfirmedRegistration(');
    // The old trigger recorded on a 'partial' local hint set when a leg was only SENT.
    expect(provider).not.toContain('subscribeReceiveSetup');
  });
});

describe('one policy for every session-account read: registry only', () => {
  /** Every own-account path the SDK walks, over one interactor. */
  const paths = (interactor: Parameters<typeof sdkIsRegistered>[0] & Parameters<typeof sdkIsViewingKeySet>[0]) => ({
    deposit: () => sdkIsRegistered(interactor),
    registration: async () => [await sdkIsRegistered(interactor), await sdkIsViewingKeySet(interactor)],
    paymentRequest: () => sdkIsViewingKeySet(interactor),
    spend: () => sdkIsRegistered(interactor),
    exit: () => sdkIsRegistered(interactor),
  });

  for (const stale of [false, true]) {
    test(`${stale ? 'stale' : 'empty'} registry: every path refuses without RPC`, async () => {
      if (stale) {
        store.set(envScopedStorageKey(`ppv2_nullifying_key_hashes_v1_${CHAIN}`), JSON.stringify({
          byAccount: {}, lastSyncedId: '1', lastSyncedAt: Date.now() - 24 * 3600_000,
        }));
      }
      const { interactor, calls } = fakeChain({ hash: MINE, viewingKey: VK });
      routeOwnKeystoreReads(interactor, { chainId: CHAIN, ownerAddress: OWNER });
      for (const read of Object.values(paths(interactor))) {
        await expect(read()).rejects.toThrow(REGISTRY_SYNCING_MESSAGE);
      }
      expect(calls).toEqual([]);
    });
  }

  test('registry hit: ZERO account-keyed reads on every own-account path', async () => {
    seedCurrentRegistries({ [OWNER]: MINE }, { [OWNER]: VK });
    const { interactor, calls } = fakeChain();
    routeOwnKeystoreReads(interactor, { chainId: CHAIN, ownerAddress: OWNER });
    const p = paths(interactor);
    expect(await p.deposit()).toBe(true);
    expect(await p.registration()).toEqual([true, true]);
    expect(await p.paymentRequest()).toBe(true);
    expect(await p.spend()).toBe(true);
    expect(await p.exit()).toBe(true);
    expect(calls).toEqual([]);
  });

  test('concurrent reads do not influence each other: a hit stays local while an unknown read refuses', async () => {
    // Only the hash registry is current: B's viewing read has no answer locally.
    store.set(envScopedStorageKey(`ppv2_nullifying_key_hashes_v1_${CHAIN}`), JSON.stringify({ byAccount: { [OWNER]: MINE }, lastSyncedId: '1', lastSyncedAt: Date.now() }));
    const a = fakeChain({ hash: MINE });
    const b = fakeChain({ hash: MINE });
    routeOwnKeystoreReads(a.interactor, { chainId: CHAIN, ownerAddress: OWNER });
    // A second session on another account: no registry entry, stale viewing registry.
    const OTHER_OWNER = '0x00000000000000000000000000000000000d00d1';
    routeOwnKeystoreReads(b.interactor, { chainId: CHAIN, ownerAddress: OTHER_OWNER });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // A long spend in flight on A (proofs take seconds) while B reads.
    const spend = (async () => { await gate; return a.interactor.getNullifyingKeyHash(OWNER); })();
    await expect(b.interactor.getViewingKey(OTHER_OWNER)).rejects.toThrow(REGISTRY_SYNCING_MESSAGE);
    release();
    expect(await spend).toBe(MINE);
    // A answered locally and B refused; neither session sent an RPC read.
    expect(a.calls).toEqual([]);
    expect(b.calls).toEqual([]);
  });

  test('there is no shared mutable scope left, and every wrapper is gone', () => {
    expect(existsSync(join(__dirname, '../keystore-read-policy.ts'))).toBe(false);
    for (const rel of [
      'services/pool-session-service.ts',
      'services/relayed-transfer.ts',
      'components/ragequit-modal-provider.tsx',
      'components/withdraw-modal-provider.tsx',
      'components/swap-modal-provider.tsx',
      'components/payment-request-modal-provider.tsx',
      'hooks/use-note-import.ts',
    ]) {
      const text = readFileSync(join(__dirname, '../..', rel), 'utf8');
      expect(text).not.toContain('withChainFallback');
      expect(text).not.toContain('keystore-read-policy');
    }
    const reads = readFileSync(join(__dirname, '../keystore-registry-reads.ts'), 'utf8');
    expect(reads).not.toMatch(/^let /m);
    expect(reads).not.toContain('awaitKeystoreRegistries');
  });

  test('write and display checks share the registry-only path', () => {
    const src = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8');
    expect(src('services/pool-session-service.ts')).toContain('routeOwnKeystoreReads(keystoreInteractor');
    for (const path of ['components/sdk-provider.tsx', 'components/deposit-modal-provider.tsx',
      'components/keystore-registration-modal-provider.tsx', 'hooks/use-gasless-registration.ts',
      'components/payment-request-modal-provider.tsx', 'services/keystore-scope.ts']) {
      expect(src(path)).not.toContain('chainFallback');
    }
    expect(src('components/sdk-provider.tsx')).not.toContain('ks.getNullifyingKeyHash(addr)');
    expect(src('components/sdk-provider.tsx')).not.toContain('ks.getViewingKey(addr)');
  });
});

describe('recipients keep their behavior', () => {
  test('a recipient or counterparty read goes to the chain exactly as before', async () => {
    seedCurrentRegistries({ [RECIPIENT]: MINE }, { [RECIPIENT]: VK });
    const { interactor, calls } = fakeChain({ hash: MINE, viewingKey: VK });
    routeOwnKeystoreReads(interactor, { chainId: CHAIN, ownerAddress: OWNER });
    expect(await interactor.getViewingKey(RECIPIENT)).toBe(VK);
    expect(await interactor.getNullifyingKeyHash(RECIPIENT)).toBe(MINE);
    expect(calls).toEqual([
      { method: 'getViewingKey', account: RECIPIENT },
      { method: 'getNullifyingKeyHash', account: RECIPIENT },
    ]);
  });

  test('the recipient prechecks (deposit-for, transfer, claim link) still use lookupViewingKey, untouched', () => {
    const src = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8');
    expect(src('components/deposit-modal-provider.tsx')).toContain('lookupViewingKey(');
    expect(src('components/transfer-modal-provider.tsx')).toContain('lookupViewingKey(');
    // Only the signed-in account is routed; the transfer deps take it as an option.
    expect(src('services/relayed-transfer.ts')).toContain('if (ownerAddress) {');
  });
});


describe('the payment-request flow reads its own viewing key from the registry first', () => {
  test('registered, unregistered and unknown are three answers, and none sends a request', async () => {
    expect(await lookupOwnViewingKey(CHAIN, OWNER)).toEqual({ state: 'unknown' });
    seedCurrentRegistries({}, { [OWNER]: VK });
    expect(await lookupOwnViewingKey(CHAIN, OWNER)).toEqual({ state: 'registered', viewingKey: VK });
    expect(await lookupOwnViewingKey(CHAIN, RECIPIENT)).toEqual({ state: 'unregistered' });
    store.clear();
    seedCurrentRegistries({}, {});
    cache.recordOwnRegistration(CHAIN, OWNER, SCOPED, MINE, VK);
    expect(await lookupOwnViewingKey(CHAIN, OWNER)).toEqual({ state: 'registered', viewingKey: VK });
  });

  test('stale or empty registry stays unknown even for a legacy fallback caller', async () => {
    let calls = 0;
    const legacyOptions = { chainFallback: true, readChain: async () => { calls++; return VK; } };
    expect(await lookupOwnViewingKey(CHAIN, OWNER, legacyOptions as never)).toEqual({ state: 'unknown' });
    expect(calls).toBe(0);
    seedCurrentRegistries({}, { [OWNER]: VK });
    expect(await lookupOwnViewingKey(CHAIN, OWNER, legacyOptions as never)).toEqual({ state: 'registered', viewingKey: VK });
    expect(calls).toBe(0);
  });

  test('the seller lookup stays local and unknown never offers to register', () => {
    const pay = readFileSync(join(__dirname, '../../components/payment-request-modal-provider.tsx'), 'utf8');
    expect(pay).toContain('await lookupOwnViewingKey(chainId, address)');
    expect(pay).not.toContain('REGISTRY_WAIT_MS');
    expect(pay).toContain("if (ownKey.state === 'unknown')");
    expect(pay).toContain('throw new Error(REGISTRY_SYNCING_MESSAGE)');
    expect(pay).not.toContain('lookupViewingKey(');
    expect(pay).not.toContain('createKeystoreInteractor(');
  });
});
