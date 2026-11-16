// DEV-808: exit (ragequit) works while the ASP is down.
//
// The ASP is simulated down three ways: the request rejects (connection
// refused), it answers 5xx, and it never answers (a hang that only ends at the
// client's own timeout). In every case a note the chain says is spendable must
// still be listed for exit and a ragequit transaction must still be prepared,
// from chain data and local state only, with no request to the ASP on the way.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));
mock.module('expo-secure-store', () => ({ getItem: () => null, setItem: () => undefined, deleteItemAsync: async () => undefined }));

// bun has no DOM storage: a Map-backed one lets the persisted registry copy be seeded.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};

// Every fetch fails the way a down ASP does, and is counted: the exit path must
// not reach for it at all.
type Mode = 'reject' | '5xx' | 'hang';
let aspMode: Mode = 'reject';
const fetchCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
  fetchCalls.push(url);
  if (aspMode === 'reject') throw new TypeError('Failed to fetch');
  if (aspMode === '5xx') return new Response('upstream down', { status: 503 });
  return new Promise<Response>(() => { /* never answers */ });
}) as typeof fetch;
afterAll(() => { globalThis.fetch = realFetch; });

const { NoteStatus } = await import('@/services/sdk-types');
const { exitableNotes, activityFeedsUnavailable } = await import('@/services/exit-eligibility');
const { resolveEntrypointChainConfigFor } = await import('@/services/entrypoint-resolution');
const { settleWithin, KEYSTORE_HELD_LEAVES_WAIT_MS } = await import('@/services/held-copy-wait');
const { envScopedStorageKey } = await import('@/config/app-environment');
const cache = await import('@/services/nullifying-key-hash-cache');
const { routeOwnKeystoreReads } = await import('@/services/keystore-registry-reads');
const { resetBulkRegistriesForTests, sweepBulkRegistry } = await import('@/services/keystore-bulk-fallback');
const { AddressSchema, EvmAddressFieldConverter, PoolSessionRagequit } = await import('@privacy-pools-v2/sdk');

const CHAIN = 1;
const KEYSTORE = '0x00000000000000000000000000000000000beef0';
const OWNER = '0x00000000000000000000000000000000000a11ce';
const NK_HASH = `0x${'ab'.repeat(32)}`;
const COMMITMENT = `0x${'11'.repeat(32)}` as `0x${string}`;
const LABEL = `0x${'22'.repeat(32)}`;
const TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const POOL = '0x00000000000000000000000000000000000c0de0';
const KEYSTORE_LEAVES = [`0x${'33'.repeat(32)}`, `0x${'44'.repeat(32)}`];

const pinned = {
  [CHAIN]: { chainId: CHAIN, entrypoint: '0x00000000000000000000000000000000000e0e0e', pool: POOL, fromBlock: 100n },
} as never;

const aspFeedDown = (mode: Mode) => async () => {
  fetchCalls.push(`feed:${mode}`);
  if (mode === 'hang') return new Promise<never>(() => {});
  throw mode === '5xx' ? new Error('HTTP 503') : new TypeError('Failed to fetch');
};

beforeEach(() => {
  fetchCalls.length = 0;
  store.clear();
  cache.resetNullifyingKeyHashCacheForTests();
  resetBulkRegistriesForTests();
});

describe('entrypoint resolution does not wait on the ASP for a pinned chain', () => {
  for (const mode of ['reject', '5xx', 'hang'] as const) {
    test(`ASP ${mode}: the pin answers and the feed is never loaded`, async () => {
      const resolved = await resolveEntrypointChainConfigFor(CHAIN, POOL, aspFeedDown(mode), pinned);
      expect(resolved?.entrypoint).toBe('0x00000000000000000000000000000000000e0e0e');
      expect(fetchCalls).toEqual([]);
    });
  }

  test('an unpinned chain still needs the feed and reports its failure', async () => {
    await expect(resolveEntrypointChainConfigFor(10, undefined, aspFeedDown('reject'), pinned)).rejects.toThrow('Failed to fetch');
  });

  test('session init resolves the entrypoint through the pin-first resolver', () => {
    const root = join(new URL('.', import.meta.url).pathname, '..', '..');
    const src = readFileSync(join(root, 'components', 'sdk-provider.tsx'), 'utf8');
    const start = src.indexOf('const createSession = useCallback(');
    const body = src.slice(start, src.indexOf('const { createNoteManager, createCircuitArtifacts }', start));
    expect(body).toContain('resolveEntrypointChainConfigFor(');
    // Awaiting the feed before resolving is what made init fail with the ASP down.
    expect(body).not.toMatch(/await apiClient\.getEntrypoints\(\)/);
    const poolEntrypoint = readFileSync(join(root, 'services', 'pool-entrypoint.ts'), 'utf8');
    expect(poolEntrypoint).not.toMatch(/await apiClient\.getEntrypoints\(\)/);
  });
});

describe('held keystore leaves: a hanging ASP refresh is not awaited past the bound', () => {
  test('a refresh that never settles yields null, so the proof reads the chain', async () => {
    const started = Date.now();
    expect(await settleWithin(new Promise(() => {}), 20)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
  test('a failed refresh yields null', async () => {
    expect(await settleWithin(Promise.reject(new Error('HTTP 503')), 1_000)).toBeNull();
  });
  test('a held copy is used as before', async () => {
    expect(await settleWithin(Promise.resolve({ keystoreLeaves: [] }), 1_000)).toEqual({ keystoreLeaves: [] });
  });
  test('the bound is short next to the ASP client timeout (45s)', () => {
    expect(KEYSTORE_HELD_LEAVES_WAIT_MS).toBeLessThanOrEqual(15_000);
  });
});

describe('which notes can exit does not depend on the ASP', () => {
  const notes = [
    { commitment: '0xa', status: NoteStatus.PENDING },   // never reviewed: the ASP was down
    { commitment: '0xb', status: NoteStatus.ACTIVE },
    { commitment: '0xc', status: NoteStatus.REJECTED },
    { commitment: '0xd', status: NoteStatus.SPENT },
    { commitment: '0xe', status: NoteStatus.EXITED },   // exit the chain never confirmed
    { commitment: '0xf', status: NoteStatus.EXITED },   // confirmed exit
  ];
  test('pending, approved and declined notes are all listed', () => {
    expect(exitableNotes(notes, new Set(['0xe'])).map((n) => n.commitment)).toEqual(['0xa', '0xb', '0xc', '0xe']);
  });

  test('the activity list offers exit only when a feed failed with nothing held', () => {
    const base = { eventsLoaded: false, eventsFailed: false, snapshotLoaded: false, snapshotFailed: false };
    expect(activityFeedsUnavailable(base)).toBe(false); // still loading
    expect(activityFeedsUnavailable({ ...base, eventsFailed: true })).toBe(true);
    expect(activityFeedsUnavailable({ ...base, snapshotFailed: true })).toBe(true);
    // A failed refresh over held rows keeps the rows, and their Exit action.
    expect(activityFeedsUnavailable({ eventsLoaded: true, eventsFailed: true, snapshotLoaded: true, snapshotFailed: true })).toBe(false);
  });
});

// The SDK's own ragequit preparation, wired the way the app wires it: the
// owner's registration answered by the app's registry router, keystore leaves
// from the chain, nothing from the ASP.
function ragequitSession(keystoreReads: { getNullifyingKeyHash: (a: string) => Promise<string> }) {
  const note = {
    commitment: COMMITMENT, status: NoteStatus.PENDING, value: '1000', tokenId: TOKEN,
    ownerAddress: OWNER, label: LABEL, noteSecret: `0x${'55'.repeat(32)}`,
  };
  const chainLeafReads: string[] = [];
  const witnessInputs: unknown[] = [];
  const session = new PoolSessionRagequit({
    ownerAddress: OWNER,
    addressSchema: AddressSchema,
    addressFieldConverter: new EvmAddressFieldConverter(),
    noteManager: { getNote: (c: string) => { if (c !== COMMITMENT) throw new Error('missing'); return note; } },
    keystoreManager: { getPrivateNullifyingKey: () => '0x01', getPrivateRevocableKey: () => '0x02' },
    keystoreInteractor: {
      ...keystoreReads,
      getKeystoreLeaves: async () => { chainLeafReads.push('keystore'); return KEYSTORE_LEAVES; },
    },
    witnessPreparationService: {
      buildRagequitWitness: async (inputs: unknown) => { witnessInputs.push(inputs); return { witness: { ok: true }, nullifierHash: '0x99' }; },
    },
    proofService: { proveRagequit: async () => ({ proof: 'p' }), formatForChain: () => ({ formatted: true }) },
    poolVaultInteractor: { encodeRagequit: async () => ({ to: POOL, data: '0xdead', value: '0' }) },
    rpcInteractor: {},
    preparedTxVerifier: {},
  } as never);
  return { session, chainLeafReads, witnessInputs };
}

describe('a note can still be exited with the ASP down', () => {
  for (const mode of ['reject', '5xx'] as const) {
    test(`ASP ${mode}: a returning user's persisted registration answers, the proof is built from chain leaves`, async () => {
      aspMode = mode;
      // A registry pulled in an earlier session. The hash is write-once on
      // chain, so a hit answers however old the copy is.
      store.set(envScopedStorageKey(`ppv2_nullifying_key_hashes_v1_${CHAIN}_${KEYSTORE}`), JSON.stringify({
        byAccount: { [OWNER]: NK_HASH }, lastSyncedId: '7', lastSyncedAt: 1,
      }));
      // The grid's pull of the registry fails like the ASP does.
      const outcome = await cache.syncNullifyingKeyHashes(CHAIN, KEYSTORE, undefined, async () => undefined);
      expect(outcome.ok).toBe(false);
      fetchCalls.length = 0;

      const reads = routeOwnKeystoreReads({ getNullifyingKeyHash: async () => '0x0', getViewingKey: async () => '0x0' }, { chainId: CHAIN, keystoreAddress: KEYSTORE, ownerAddress: OWNER });
      const { session, chainLeafReads, witnessInputs } = ragequitSession(reads);
      const result = await session.prepareRageQuit({ commitment: COMMITMENT });

      expect(result.ragequitTx).toEqual({ to: POOL, data: '0xdead', value: '0' });
      expect(result.recipientAddress).toBe(OWNER);
      expect(chainLeafReads).toEqual(['keystore']);
      expect((witnessInputs[0] as { keystoreLeaves: string[] }).keystoreLeaves).toEqual(KEYSTORE_LEAVES);
      // Nothing on the exit path asked the ASP.
      expect(fetchCalls).toEqual([]);
    });
  }

  test('ASP hanging, fresh browser: the chain sweep of the keystore answers the registration', async () => {
    aspMode = 'hang';
    // Nothing persisted. The grid's ASP pull would hang, so it is not awaited
    // here; the grid's own chain sweep (keystore events, no account filter)
    // makes the registry current instead.
    const ok = await sweepBulkRegistry(CHAIN, KEYSTORE, 100n, 1_000n, {
      head: async () => 150n,
      blockHash: async (b) => `0x${b.toString(16).padStart(64, '0')}`,
      events: async (from, to) => (from <= 120n && 120n <= to
        ? [{ kind: 'auth', account: OWNER, value: NK_HASH, blockNumber: 120n, logIndex: 0 }]
        : []),
    });
    expect(ok).toBe(true);

    const reads = routeOwnKeystoreReads({ getNullifyingKeyHash: async () => '0x0', getViewingKey: async () => '0x0' }, { chainId: CHAIN, keystoreAddress: KEYSTORE, ownerAddress: OWNER });
    const { session } = ragequitSession(reads);
    const result = await session.prepareRageQuit({ commitment: COMMITMENT });
    expect(result.ragequitTx.to).toBe(POOL);
    expect(fetchCalls).toEqual([]);
  });
});
