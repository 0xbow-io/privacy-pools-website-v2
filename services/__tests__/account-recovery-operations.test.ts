import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { withBackupDeadline } from '../backup-preparation';

// Execute the actual modal callbacks without mounting wagmi, Expo or the SDK.
const source = ts.createSourceFile('recovery.tsx', readFileSync(new URL('../../components/account-recovery-modal-provider.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const provider = source.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === 'AccountRecoveryModalProvider')!;
function callback(name: string, env: Record<string, unknown>) {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found = node.initializer as ts.CallExpression;
    ts.forEachChild(node, visit);
  };
  visit(provider);
  if (!found) throw new Error(`Missing callback ${name}`);
  return new Function(...Object.keys(env), ts.transpileModule(`return (${found.arguments[0].getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText)(...Object.values(env));
}
function resetContext(env: Record<string, unknown>) {
  const effect = provider.body!.statements.find((s): s is ts.ExpressionStatement => ts.isExpressionStatement(s)
    && ts.isCallExpression(s.expression) && s.expression.expression.getText(source) === 'useEffect'
    && s.expression.arguments[0].getText(source).includes('setExportPayload'))!;
  const fn = (effect.expression as ts.CallExpression).arguments[0];
  return new Function(...Object.keys(env), ts.transpileModule(`return (${fn.getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText)(...Object.values(env))();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function harness() {
  const state: Record<string, any> = {};
  const poolSession = {};
  const env: Record<string, any> = {
    address: 'owner', chainId: 8453, poolSession, isStellar: false, useEncryption: false,
    password: '', confirmPassword: '',
    exportAttemptRef: { current: 0 }, exportBusyRef: { current: false },
    exportContextRef: { current: { address: 'owner', chainId: 8453, poolSession } },
    withBackupDeadline: (work: Promise<unknown>) => withBackupDeadline(work, 20),
    resolveCurrentExport: async () => ({ notes: [{}] }),
    prepareAccountBackup: async () => ({ serialized: 'backup', encrypted: false, warning: null }),
    stellarExportBackup: async () => ({ payload: 'stellar-backup', noteCount: 2 }),
    stellarErrorMessage: (message: string) => message,
    resetMessages: () => { state.error = null; state.warning = null; state.status = null; },
  };
  for (const [setter, field] of Object.entries({
    setIsPreparingExport: 'busy', setErrorMessage: 'error', setWarningMessage: 'warning',
    setStatusMessage: 'status', setExportPayload: 'payload', setExportTarget: 'target',
    setIsEncryptedBackup: 'encrypted', setIsOpen: 'open', setIsImporting: 'importing',
    setPassword: 'password', setConfirmPassword: 'confirmPassword', setNeedsPassword: 'needsPassword',
    setMode: 'mode', setUseEncryption: 'useEncryption', setImportPayload: 'importPayload',
  })) env[setter] = (value: unknown) => { state[field] = value; };
  return { state, env, run: () => callback('handlePrepareExport', env)(), close: () => callback('closeAccountRecoveryModal', env)(), open: () => callback('openExportNotesModal', env)(),
    changeContext: (change: object) => { Object.assign(env.exportContextRef.current, change); resetContext(env); } };
}

test('export prepares the exact backup and binds its download to the owner and chain', async () => {
  const h = harness();
  await h.run();
  expect(h.state.payload).toBe('backup');
  expect(h.state.target).toEqual({ address: 'owner', chainId: 8453 });
  expect(h.state.busy).toBe(false);
});

test('opening the export modal does not silently start an export', () => {
  const h = harness();
  let calls = 0;
  h.env.resolveCurrentExport = () => { calls++; };
  h.open();
  expect(calls).toBe(0);
  expect(h.state.busy).toBe(false);
});

test('password validation happens before accessing recovery data', async () => {
  const h = harness();
  h.env.useEncryption = true;
  h.env.resolveCurrentExport = () => { throw new Error('must not read'); };
  await h.run();
  expect(h.state.error).toBe('Enter a password.');
});

test('a storage error is surfaced and the retry button is released', async () => {
  const h = harness();
  h.env.resolveCurrentExport = async () => { throw new Error('storage unavailable'); };
  await h.run();
  expect(h.state.error).toBe('storage unavailable');
  expect(h.state.busy).toBe(false);
});

test('a timed-out read cannot later begin backup preparation', async () => {
  const h = harness();
  const data = deferred<unknown>();
  h.env.resolveCurrentExport = () => data.promise;
  h.env.prepareAccountBackup = () => { throw new Error('late preparation must not run'); };
  await h.run();
  expect(h.state.error).toContain('Backup took too long');
  expect(h.state.busy).toBe(false);
  data.resolve({ notes: [{}] });
  await Promise.resolve();
  expect(h.state.payload).toBeUndefined();
});

test('a late prepared backup cannot overwrite a successful retry', async () => {
  const h = harness();
  const old = deferred<unknown>();
  h.env.prepareAccountBackup = () => old.promise;
  await h.run();
  h.env.prepareAccountBackup = async () => ({ serialized: 'retry', encrypted: false, warning: null });
  await h.run();
  old.resolve({ serialized: 'old', encrypted: false, warning: null });
  await Promise.resolve();
  expect(h.state.payload).toBe('retry');
});

test('closing and reopening invalidates an in-flight backup', async () => {
  const h = harness();
  const work = deferred<unknown>();
  h.env.prepareAccountBackup = () => work.promise;
  const pending = h.run();
  await Promise.resolve();
  h.close();
  h.open();
  work.resolve({ serialized: 'old account', encrypted: false, warning: null });
  await pending;
  expect(h.state.payload).toBe('');
  expect(h.state.busy).toBe(false);
});

test('an account, chain, or unlock change discards the result', async () => {
  for (const change of [{ address: 'other' }, { chainId: 1 }, { poolSession: {} }]) {
    const h = harness();
    const work = deferred<unknown>();
    h.env.prepareAccountBackup = () => work.promise;
    const pending = h.run();
    await Promise.resolve();
    h.changeContext(change);
    work.resolve({ serialized: 'old account', encrypted: false, warning: null });
    await pending;
    expect(h.state.payload).toBe('');
    expect(h.state.target).toBeNull();
    expect(h.state.busy).toBe(false);
  }
});

test('Stellar keeps its password-encrypted wallet backup flow', async () => {
  const h = harness();
  h.env.isStellar = true;
  h.env.password = h.env.confirmPassword = 'test-password';
  await h.run();
  expect(h.state.payload).toBe('stellar-backup');
  expect(h.state.encrypted).toBe(true);
  expect(h.state.busy).toBe(false);
});

test('duplicate Generate presses do not start parallel exports', async () => {
  const h = harness();
  const work = deferred<unknown>();
  let calls = 0;
  h.env.resolveCurrentExport = () => { calls++; return work.promise; };
  const pending = h.run();
  await h.run();
  expect(calls).toBe(1);
  work.resolve({ notes: [] });
  await pending;
  expect(h.state.warning).toContain('No notes');
});
