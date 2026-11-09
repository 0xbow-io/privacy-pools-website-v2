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
const { identityStatusFromRegistry, identityStatusWithChainFallback, ownRegistrationRefusal, REGISTRATION_UNCONFIRMED_MESSAGE } = await import('@/services/keystore-identity-status');
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

  test('missing data is NOT unregistered: the chain answers at once, no wait, no refusal', async () => {
    const { interactor, calls } = fakeChain({ hash: MINE, viewingKey: VK });
    routeOwnKeystoreReads(interactor, { chainId: CHAIN, ownerAddress: OWNER });
    const started = Date.now();
    expect(await sdkIsRegistered(interactor)).toBe(true);
    expect(await sdkIsViewingKeySet(interactor)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls.map((c) => c.method)).toEqual(['getNullifyingKeyHash', 'getViewingKey']);
  });

  test('missing data with an unregistered chain reads as unregistered only because the CHAIN said so', async () => {
    const { interactor, calls } = fakeChain();
    routeOwnKeystoreReads(interactor, { chainId: CHAIN, ownerAddress: OWNER });
    expect(await sdkIsRegistered(interactor)).toBe(false);
    expect(calls.length).toBe(1);
  });

  test('a failed chain read stays a failure, never "unregistered"', async () => {
    const interactor = {
      getNullifyingKeyHash: async () => { throw new Error('rpc down'); },
      getViewingKey: async () => { throw new Error('rpc down'); },
    };
    routeOwnKeystoreReads(interactor, { chainId: CHAIN, ownerAddress: OWNER });
    await expect(sdkIsRegistered(interactor)).rejects.toThrow('rpc down');
    await expect(sdkIsViewingKeySet(interactor)).rejects.toThrow('rpc down');
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

describe('one policy for every own-account read: registry first, then the chain, never a wait', () => {
  /** Every own-account path the SDK walks, over one interactor. */
  const paths = (interactor: Parameters<typeof sdkIsRegistered>[0] & Parameters<typeof sdkIsViewingKeySet>[0]) => ({
    deposit: () => sdkIsRegistered(interactor),
    registration: async () => [await sdkIsRegistered(interactor), await sdkIsViewingKeySet(interactor)],
    paymentRequest: () => sdkIsViewingKeySet(interactor),
    spend: () => sdkIsRegistered(interactor),
    exit: () => sdkIsRegistered(interactor),
  });

  test('stale or empty registry: every path goes to the chain and succeeds at once', async () => {
    const { interactor, calls } = fakeChain({ hash: MINE, viewingKey: VK });
    routeOwnKeystoreReads(interactor, { chainId: CHAIN, ownerAddress: OWNER });
    const started = Date.now();
    const p = paths(interactor);
    expect(await p.deposit()).toBe(true);
    expect(await p.registration()).toEqual([true, true]);
    expect(await p.paymentRequest()).toBe(true);
    expect(await p.spend()).toBe(true);
    expect(await p.exit()).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls.length).toBe(6);
  });

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

  test('concurrent reads do not influence each other: a hit stays local while a miss goes to the chain', async () => {
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
    const viewing = await b.interactor.getViewingKey(OTHER_OWNER);
    release();
    expect(await spend).toBe(MINE);
    expect(viewing).toBe(`0x${'0'.repeat(64)}`);
    // A answered from the registry (no read), B asked the chain once.
    expect(a.calls).toEqual([]);
    expect(b.calls.map((c) => c.method)).toEqual(['getViewingKey']);
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

  test('the session factory routes the own account and the deposit and registration checks ask for the chain fallback', () => {
    const src = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8');
    expect(src('services/pool-session-service.ts')).toContain('routeOwnKeystoreReads(keystoreInteractor');
    expect(src('components/deposit-modal-provider.tsx')).toContain('keystoreStatusForChain(depositChainId, { chainFallback: true })');
    expect(src('components/keystore-registration-modal-provider.tsx')).toContain('keystoreStatusForChain(chainId, { chainFallback: true })');
    expect(src('hooks/use-gasless-registration.ts')).toContain('keystoreStatusForChain(chainId, { chainFallback: true })');
    // The sdk-provider write guards (deposit, swap source) take the fallback with no wait.
    expect(src('components/sdk-provider.tsx')).toMatch(/targetChainId,\n\s+0,\n\s+true,/);
    expect(src('components/sdk-provider.tsx')).toMatch(/committed\.chainId,\n\s+0,\n\s+true,/);
  });
});

describe('the identity check asks the registry first and the chain only when it has no answer', () => {
  const ACTIVE = BigInt(MINE).toString();
  const VIEW = `0x${'aa'.repeat(32)}`;
  const noData = { nullifyingKeyHash: null, nullifyingFresh: false, viewingKey: null, viewingFresh: false };
  const reads = (hash: string | null, viewing: string | null) => {
    const log: string[] = [];
    return {
      log,
      chain: {
        readNullifyingKeyHash: async () => { log.push('hash'); return hash; },
        readViewingKey: async () => { log.push('viewing'); return viewing; },
      },
    };
  };

  test('no registry data and no fallback is unknown, with no chain read', async () => {
    const { log } = reads(MINE, VIEW);
    expect(await identityStatusWithChainFallback(noData, ACTIVE, VIEW, null)).toBe('unknown');
    expect(log).toEqual([]);
  });

  test('no registry data with the fallback: the chain decides, in the old read order', async () => {
    let r = reads(MINE, VIEW);
    expect(await identityStatusWithChainFallback(noData, ACTIVE, VIEW, r.chain)).toBe('compatible');
    expect(r.log).toEqual(['hash', 'viewing']);
    r = reads(`0x${'0'.repeat(64)}`, null);
    expect(await identityStatusWithChainFallback(noData, ACTIVE, VIEW, r.chain)).toBe('unregistered');
    expect(r.log).toEqual(['hash']);
    r = reads(`0x${'22'.repeat(32)}`, VIEW);
    expect(await identityStatusWithChainFallback(noData, ACTIVE, VIEW, r.chain)).toBe('incompatible');
    expect(r.log).toEqual(['hash']);
    r = reads(MINE, `0x${'0'.repeat(64)}`);
    expect(await identityStatusWithChainFallback(noData, ACTIVE, VIEW, r.chain)).toBe('partial');
  });

  test('a registry answer sends no chain read, even with the fallback on', async () => {
    const hit = { nullifyingKeyHash: MINE, nullifyingFresh: true, viewingKey: VIEW, viewingFresh: true };
    const r = reads(`0x${'22'.repeat(32)}`, null);
    expect(await identityStatusWithChainFallback(hit, ACTIVE, VIEW, r.chain)).toBe('compatible');
    expect(await identityStatusWithChainFallback({ ...noData, nullifyingFresh: true }, ACTIVE, VIEW, r.chain)).toBe('unregistered');
    expect(r.log).toEqual([]);
  });

  test('a failed chain read throws, it is never unregistered or compatible', async () => {
    const chain = { readNullifyingKeyHash: async () => { throw new Error('rpc down'); }, readViewingKey: async () => null };
    await expect(identityStatusWithChainFallback(noData, ACTIVE, VIEW, chain)).rejects.toThrow('rpc down');
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

  test('stale or empty registry with the fallback: the chain answers at once, and a hit sends nothing', async () => {
    const reads: string[] = [];
    const readChain = async (_chainId: number, account: string) => { reads.push(account); return VK; };
    const started = Date.now();
    expect(await lookupOwnViewingKey(CHAIN, OWNER, { chainFallback: true, readChain })).toEqual({ state: 'registered', viewingKey: VK });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(reads).toEqual([OWNER]);
    // The chain says zero: unregistered, because the chain said so.
    const zero = async () => `0x${'0'.repeat(64)}`;
    expect(await lookupOwnViewingKey(CHAIN, OWNER, { chainFallback: true, readChain: zero })).toEqual({ state: 'unregistered' });
    // Without the fallback the same lookup stays unknown.
    expect(await lookupOwnViewingKey(CHAIN, OWNER, { readChain })).toEqual({ state: 'unknown' });
    // A current registry answers first: no chain read.
    seedCurrentRegistries({}, { [OWNER]: VK });
    reads.length = 0;
    expect(await lookupOwnViewingKey(CHAIN, OWNER, { chainFallback: true, readChain })).toEqual({ state: 'registered', viewingKey: VK });
    expect(reads).toEqual([]);
  });

  test('a failed chain read throws and is never turned into unregistered', async () => {
    const readChain = async () => { throw new Error('rpc down'); };
    await expect(lookupOwnViewingKey(CHAIN, OWNER, { chainFallback: true, readChain })).rejects.toThrow('rpc down');
  });

  test('the seller lookup asks for the fallback with no wait, and unknown never offers to register', () => {
    const pay = readFileSync(join(__dirname, '../../components/payment-request-modal-provider.tsx'), 'utf8');
    expect(pay).toContain('await lookupOwnViewingKey(chainId, address, { chainFallback: true })');
    expect(pay).not.toContain('REGISTRY_WAIT_MS');
    expect(pay).toContain("if (ownKey.state === 'unknown')");
    expect(pay).toContain('throw new Error(REGISTRY_SYNCING_MESSAGE)');
    expect(pay).not.toContain('lookupViewingKey(');
    expect(pay).not.toContain('createKeystoreInteractor(');
  });
});
