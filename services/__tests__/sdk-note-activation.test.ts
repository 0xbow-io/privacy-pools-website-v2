import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import { invalidateTransactionCaches } from '../cache';

// Execute the actual provider effect, including its dependency array, without
// booting wagmi/native UI. The manager and its transition rules come from the
// PINNED tarball, not possibly stale node_modules and not a copied state machine.
// `import.meta.dir` is a Bun extension the app tsconfig does not model, and
// the CI gate runs the typecheck script. The URL form is standard and resolves
// identically under the same runner (same fix as no-targeted-reads.test.ts).
const root = resolve(new URL('.', import.meta.url).pathname, '../..');
const source = readFileSync(resolve(root, 'components/sdk-provider.tsx'), 'utf8');
const parse = (name: string, text: string) => ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const providerAst = parse('provider.tsx', source);
const provider = providerAst.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'SdkProvider')!;
const effect = provider.body!.statements.find((s) => ts.isExpressionStatement(s)
  && ts.isCallExpression(s.expression) && s.expression.expression.getText(providerAst) === 'useEffect'
  && s.getText(providerAst).includes('const storedForPromotion'))!;
// The decisions moved off useQuery onto the public-feed grid; these are the
// statements that replaced the poll (see 'decisions are read from the grid'
// below). Taken as a group because the memo reads the feed state above it.
const providerDecl = (name: string) => provider.body!.statements.find((s) => ts.isVariableStatement(s)
  && s.declarationList.declarations.some((d) => d.name.getText(providerAst) === name))!.getText(providerAst);
const blockedFeedSource = ['blockedLabelsFeed', 'blockedDecisions', 'blockedLabelHashes']
  .map(providerDecl).join('\n');
function named(ast: ts.SourceFile, name: string): string {
  const statement = ast.statements.find((s) => (
    ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => d.name.getText(ast) === name)
  ) || (ts.isFunctionDeclaration(s) && s.name?.text === name));
  if (!statement) throw new Error(`Missing production declaration: ${name}`);
  return statement.getText(ast);
}
const compile = (code: string, env: Record<string, unknown>) => {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(env), js)(...Object.values(env));
};
const spec = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).dependencies['@privacy-pools-v2/sdk'];
const sdkSource = execFileSync('tar', ['-xOf', resolve(root, spec.slice(5)), 'package/dist/index.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const sdkAst = parse('sdk.js', sdkSource);
const runtimeNames = ['NoteStatus', 'VALID_STATUS_TRANSITIONS', 'bigintToHex', 'HexSchema', 'AddressSchema',
  'NoteAddressHashSchema', 'HashInputSchema', 'makeBaseNoteSchema', 'makePendingNoteSchema', 'makeNoteSchema',
  'makeNoteManagerStateSchema', 'PendingNoteSchema', 'NoteSchema', 'NoteManagerBaseError',
  'InvalidNoteError', 'NoteNotFoundError', 'InvalidStatusTransitionError', 'NoteConflictError', 'InvalidLineageError',
  'defaultNoteIdentityComparator', 'NoteManager'];
// The split SDK bundle imports zod twice (default as z6, named as z).
const runtime = new Function('z', 'z6', runtimeNames.map((n) => named(sdkAst, n)).join('\n')
  + '\nreturn { NoteManager, NoteStatus, VALID_STATUS_TRANSITIONS, HashInputSchema };')(z, z);
const setupAst = parse('setup.ts', readFileSync(resolve(root, 'services/sdk-setup.ts'), 'utf8'));
const createManager = compile(named(setupAst, 'createNoteManager').replace('export ', '') + '\nreturn createNoteManager;', runtime);
const supportCode = ['normalizeHashValue', 'SDK_STATUS_TRANSITIONS'].map((n) => named(providerAst, n)).join('\n');
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const owner = `0x${'1'.repeat(40)}`;
const pool = `0x${'2'.repeat(40)}`;
function note(status = 'PENDING', commitment = hash(1), label: unknown = hash(10)) {
  return { commitment, label, status, value: '0x2', tokenId: pool, ownerAddress: owner,
    noteSecret: hash(3), noteAddressHash: hash(4), isOwned: true, createdAtBlock: '0x1', spentAtBlock: null, txHash: hash(5) };
}
const flush = async () => { await new Promise((done) => setImmediate(done)); };
function harness(initial = [note()], live = false) {
  let stored = { notes: structuredClone(initial), syncCursor: '0x7', paymentRequests: [{ id: 'preserve' }], extra: 'preserve' };
  const manager = live ? createManager() : null;
  if (manager) initial.forEach((n) => manager.addNote(structuredClone(n)));
  const saves: unknown[] = [];
  const hashes: unknown[] = [];
  const logs: unknown[][] = [];
  const exports: unknown[][] = [];
  const committed = live ? { address: owner, chainId: 1, noteManager: manager } : null;
  let previousDeps: unknown[] | undefined;
  let cleanup: (() => void) | undefined;
  const env: Record<string, any> = {
    NoteStatus: runtime.NoteStatus, effectiveAddress: owner, chainId: 1, configuredPoolAddress: pool,
    associationSetLeaves: [hash(10)], associationSetLeavesReady: true, associationSetLeavesScopeKey: '1:pool:root',
    blockedLabelHashes: [], blockedLabelsSucceeded: true, txPending: false, isSyncing: false,
    backgroundDiscoveryRef: { current: 0 },
    noteManager: manager, notesRevision: 0, poolSession: live ? {} : null,
    committedSessionRef: { current: committed }, batchSessionParamsRef: { current: live ? { poolAddress: pool } : null },
    liveIdentityRef: { current: { address: owner, chainId: 1 } },
    getSdkSetup: async () => ({ createHashService: async () => ({ hash: ([label]: unknown[]) => {
      if (!runtime.HashInputSchema.safeParse([label]).success) throw new Error('Invalid hash inputs');
      hashes.push(label); return String(label);
    } }) }),
    loadStoredAccountExport: () => structuredClone(stored),
    saveStoredAccountExport: (data: typeof stored, address: string, chain: number) => {
      saves.push({ data, address, chain }); stored = structuredClone(data);
    },
    exportAccount: async (...args: unknown[]) => { exports.push(args); env.notesRevision += 1; },
    refreshNotes: () => { env.notesRevision += 1; },
    log: (...args: unknown[]) => { logs.push(args); },
    useEffect: (run: () => (() => void) | undefined, deps: unknown[]) => {
      if (previousDeps && deps.every((d, i) => Object.is(d, previousDeps![i]))) return;
      cleanup?.(); previousDeps = deps; cleanup = run();
    },
  };
  const render = () => compile(supportCode + '\n' + effect.getText(providerAst), env);
  return { env, saves, hashes, logs, exports, manager, render, flush,
    notes: () => manager ? manager.getNotes() : stored.notes,
    setStored: (notes: ReturnType<typeof note>[]) => { stored.notes = structuredClone(notes); },
    dispose: () => cleanup?.() };
}

for (const live of [false, true]) describe(live ? 'live pinned SDK activation' : 'stored activation', () => {
  test('promotes all eligible notes by their own labels, without events or amount matching', async () => {
    const h = harness([note(), note('INACTIVE', hash(2)), note('PENDING', hash(3), hash(11))], live);
    h.render(); await h.flush();
    expect(h.notes().map((n: any) => n.status)).toEqual(['ACTIVE', 'ACTIVE', 'PENDING']);
    expect(h.env.notesRevision).toBe(1);
    h.render(); await h.flush();
    expect(h.env.notesRevision).toBe(1); // no promotion/refresh loop
    if (live) expect(h.exports).toEqual([[]]); // committed export, no render-scoped override
    else expect(h.saves[0]).toMatchObject({ address: owner, chain: 1, data: {
      syncCursor: '0x7', paymentRequests: [{ id: 'preserve' }], extra: 'preserve',
    } });
  });
  test('a declined label still in the published set is not promoted', async () => {
    const h = harness([note()], live);
    h.env.blockedLabelHashes = [hash(10)];
    h.render(); await h.flush();
    expect(h.notes()[0].status).toBe('PENDING');
    expect(h.saves).toHaveLength(0); expect(h.exports).toHaveLength(0);
    h.env.blockedLabelHashes = []; // reapproval without a root change
    h.render(); await h.flush();
    expect(h.notes()[0].status).toBe('ACTIVE');
  });
  test('absence never demotes ACTIVE, and terminal/rejected notes never recover here', async () => {
    const h = harness(['ACTIVE', 'SPENT', 'EXITED', 'REJECTED'].map((s, i) => note(s, hash(i + 1))), live);
    h.env.associationSetLeaves = [hash(999)];
    h.render(); await h.flush();
    h.env.associationSetLeaves = [hash(10)];
    h.render(); await h.flush();
    expect(h.notes().map((n: any) => n.status)).toEqual(['ACTIVE', 'SPENT', 'EXITED', 'REJECTED']);
    expect(h.hashes).toHaveLength(0); expect(h.exports).toHaveLength(0); expect(h.saves).toHaveLength(0);
  });
  test('new notes in an unchanged lineage trigger through notesRevision', async () => {
    const h = harness([], live);
    h.render(); await h.flush();
    if (live) h.manager.addNote(note()); else h.setStored([note()]);
    h.env.notesRevision += 1;
    h.render(); await h.flush();
    expect(h.notes()[0].status).toBe('ACTIVE');
  });
  for (const reason of ['empty', 'failed-leaves', 'failed-rejections', 'missing-rejections', 'transaction', 'discovery']) {
    test(`leaves statuses untouched during ${reason}`, async () => {
      const h = harness([note(), note('ACTIVE', hash(2))], live);
      if (reason === 'empty') h.env.associationSetLeaves = [];
      if (reason === 'failed-leaves') h.env.associationSetLeavesReady = false; // nonempty retained cache
      if (reason === 'failed-rejections') h.env.blockedLabelsSucceeded = false;
      if (reason === 'missing-rejections') h.env.blockedLabelHashes = undefined;
      if (reason === 'transaction') h.env.txPending = true;
      if (reason === 'discovery') h.env.isSyncing = true;
      if (reason === 'scheduled discovery') h.env.backgroundDiscoveryRef.current = 1;
      h.render(); await h.flush();
      expect(h.notes().map((n: any) => n.status)).toEqual(['PENDING', 'ACTIVE']);
      expect(h.hashes).toHaveLength(0); expect(h.saves).toHaveLength(0); expect(h.exports).toHaveLength(0);
      if (reason === 'transaction' || reason === 'discovery') {
        h.env.txPending = false; h.env.isSyncing = false;
        h.render(); await h.flush();
        expect(h.notes()[0].status).toBe('ACTIVE');
      }
      if (reason === 'scheduled discovery') {
        // A scheduled pass is a ref, not state: its end bumps notesRevision.
        h.env.backgroundDiscoveryRef.current = 0;
        h.env.notesRevision += 1;
        h.render(); await h.flush();
        expect(h.notes()[0].status).toBe('ACTIVE');
      }
    });
  }
});

test('malformed labels cannot abort other notes or the storage write/diagnostics', async () => {
  const bad = [undefined, null, '', 'garbage', '0x', 12].map((label, i) => note('PENDING', hash(i + 2), label));
  bad[0].label = undefined;
  const h = harness([note('SPENT', hash(20), null), ...bad, note()]);
  h.render(); await h.flush();
  expect(h.notes().at(-1)!.status).toBe('ACTIVE');
  expect(h.notes().slice(0, -1).map((n: any) => n.status)).toEqual(['SPENT', ...bad.map(() => 'PENDING')]);
  expect(h.saves).toHaveLength(1);
  expect(h.logs.some((l) => l[0] === 'error')).toBe(false);
});

test('one hash failure is isolated, including when a good note preceded it', async () => {
  const h = harness([note(), note('PENDING', hash(2), hash(11)), note('PENDING', hash(3))]);
  h.env.getSdkSetup = async () => ({ createHashService: async () => ({ hash: ([label]: string[]) => {
    if (label === hash(11)) throw new Error('unhashable'); return label;
  } }) });
  h.render(); await h.flush();
  expect(h.notes().map((n: any) => n.status)).toEqual(['ACTIVE', 'PENDING', 'ACTIVE']);
  expect(h.saves).toHaveLength(1);
});

test('raw status casing and duplicate commitments use the running storage status', async () => {
  const h = harness(['pending', 'inactive', 'active', 'spent', 'exited', 'rejected', 'Pending', 'unknown']
    .map((s, i) => note(s, hash(i + 1))));
  h.render(); await h.flush();
  expect(h.notes().map((n: any) => n.status)).toEqual(['ACTIVE', 'ACTIVE', 'active', 'spent', 'exited', 'rejected', 'ACTIVE', 'unknown']);
  const duplicate = harness([note('INACTIVE'), note('INACTIVE')]);
  duplicate.render(); await duplicate.flush();
  expect(duplicate.notes().map((n: any) => n.status)).toEqual(['ACTIVE', 'ACTIVE']);
  expect(duplicate.logs.at(-1)?.[3]).toMatchObject({ promotedCount: 1, pendingCount: 0 });
});

for (const mismatch of ['chain', 'owner', 'pool', 'manager', 'no-commit']) {
  test(`a nonempty set cannot mutate a manager with a mismatched ${mismatch}`, async () => {
    const h = harness([note()], true);
    if (mismatch === 'chain') h.env.committedSessionRef.current.chainId = 56;
    if (mismatch === 'owner') h.env.committedSessionRef.current.address = pool;
    if (mismatch === 'pool') h.env.batchSessionParamsRef.current.poolAddress = owner;
    if (mismatch === 'manager') h.env.committedSessionRef.current.noteManager = {};
    if (mismatch === 'no-commit') h.env.committedSessionRef.current = null;
    h.render(); await h.flush();
    expect(h.notes()[0].status).toBe('PENDING'); expect(h.hashes).toHaveLength(0); expect(h.exports).toHaveLength(0);
  });
}

test('a switch during hash initialization cannot mutate or persist the old manager', async () => {
  const h = harness([note()], true);
  let finish!: (value: unknown) => void;
  h.env.getSdkSetup = async () => ({ createHashService: () => new Promise((done) => { finish = done; }) });
  h.render(); await h.flush();
  h.env.committedSessionRef.current = null;
  h.env.liveIdentityRef.current.chainId = 56;
  finish({ hash: ([label]: unknown[]) => label });
  await h.flush();
  expect(h.notes()[0].status).toBe('PENDING'); expect(h.exports).toHaveLength(0);
});

test('storage is read after awaits, preserving notes imported during initialization', async () => {
  const h = harness();
  let finish!: (value: unknown) => void;
  h.env.getSdkSetup = async () => ({ createHashService: () => new Promise((done) => { finish = done; }) });
  h.render(); await h.flush();
  h.setStored([note(), note('SPENT', hash(2))]);
  finish({ hash: ([label]: unknown[]) => label });
  await h.flush();
  expect(h.notes().map((n: any) => n.status)).toEqual(['ACTIVE', 'SPENT']);
});

test('pinned SDK refuses ACTIVE to PENDING; swallowed transitions do not log false promotions', async () => {
  const manager = new runtime.NoteManager({});
  manager.addNote(note('ACTIVE'));
  expect(() => manager.updateNoteStatus(hash(1), 'PENDING')).toThrow('Invalid status transition');
  expect(manager.getNote(hash(1)).status).toBe('ACTIVE');
  const h = harness([note('INACTIVE')], true);
  h.manager.updateNoteStatus = () => {};
  h.render(); await h.flush();
  expect(h.notes()[0].status).toBe('INACTIVE'); expect(h.exports).toHaveLength(0);
  expect(h.logs.at(-1)?.[3]).toMatchObject({ promotedCount: 0 });
});

test('storage transition mirror matches every status in the pinned SDK', () => {
  const table = compile(named(providerAst, 'SDK_STATUS_TRANSITIONS') + '\nreturn SDK_STATUS_TRANSITIONS;', {});
  expect(table).toEqual(runtime.VALID_STATUS_TRANSITIONS);
});

// Was a poll that paused while txPending — i.e. a request pattern that went
// quiet exactly when this client was signing. It is a scheduled feed now, so
// the test pins the read instead of the poll: the key is chain-scoped, the
// component cannot ask for a refresh, and an unusable snapshot yields undefined
// rather than an empty array (which would read as "nothing is blocked").
test('decisions are read from the grid, not polled, and absence is not permission', () => {
  const keys: string[] = [];
  const states: Record<string, unknown> = {
    'label-decisions:56': { status: 'ready', at: 1, data: { rejected: [hash(10)], poiRequired: [], entrypoint: pool } },
  };
  let state: unknown;
  const env = {
    chainId: 56, configuredPoolAddress: pool, txPending: false, isSupportedEvmChainId: () => true,
    feedLabelDecisions: (chain: number | string) => `label-decisions:${chain}`,
    usePublicFeed: (key: string) => { keys.push(key); state = states[key] ?? { status: 'empty' }; return state; },
    feedData: (s: any) => (s.status === 'ready' ? s.data : undefined),
    useMemo: (fn: () => unknown) => fn(),
  };
  const read = compile(`${blockedFeedSource}\nreturn blockedLabelHashes;`, env);
  expect(keys).toEqual(['label-decisions:56']);
  expect(read).toEqual([hash(10)]);

  // Nothing delivered yet: undefined, never [].
  env.chainId = 10;
  expect(compile(`${blockedFeedSource}\nreturn blockedLabelHashes;`, env)).toBeUndefined();

  // And the component has no door to ask for one.
  expect(blockedFeedSource).not.toContain('refetch');
  expect(blockedFeedSource).not.toContain('txPending');
});

test('legacy mode obtains an empty rejection veto without consulting the live ASP', async () => {
  const run = compile(named(parse('public-asp-cache.ts', readFileSync(resolve(root, 'services/public-asp-cache.ts'), 'utf8')), 'getPoolBlockedLabelHashes').replace('export ', '')
    + '\nreturn getPoolBlockedLabelHashes;', { LEGACY_CONFIG: { mtId: 305 }, getPoolLabelDecisions: () => { throw new Error('live ASP must not be queried'); } });
  expect(await run(11155111)).toEqual(new Set());
});

// Decisions are scheduler-owned now, so there is no query for a transaction to
// refresh. Asserting the old key still invalidates would be vacuous — nothing
// listens — and would keep dead production code alive. What must hold is the
// opposite: a transaction opens NO door onto label decisions, because a
// refresh timed to a spend is the correlation this PR removed.
test('transaction invalidation opens no door onto label decisions', async () => {
  const keys: unknown[] = [];
  await invalidateTransactionCaches({ invalidateQueries: async ({ queryKey }: any) => { keys.push(queryKey); } } as any);
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys as string[][]) {
    expect(String(key[0]).toLowerCase()).not.toContain('label');
    expect(String(key[0]).toLowerCase()).not.toContain('rejected');
  }
  expect(keys.some((key: any) => key[0] === 'sdkAccountEvents')).toBe(false);
});

// And the source itself must not reacquire one.
test('no source outside the feed names a label-decision query key', () => {
  const cache = readFileSync(resolve(root, 'services/cache.ts'), 'utf8');
  expect(cache).not.toContain('sdkBlockedLabels');
});
