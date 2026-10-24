import { expect, test } from 'bun:test';
import { assertDepositUnlock } from '../deposit-unlock-guard';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('failed registration lookup cannot authorize a deposit', () => {
  expect(() => assertDepositUnlock('unknown')).toThrow('Could not verify');
});

test('a confirmed mismatch directs the user to their original unlock', () => {
  expect(() => assertDepositUnlock('incompatible')).toThrow('original wallet or passkey');
});

test('matching and first-time registrations preserve their existing paths', () => {
  for (const state of ['compatible', 'partial', 'unregistered'] as const) {
    expect(() => assertDepositUnlock(state)).not.toThrow();
  }
});

const providerSource = ts.createSourceFile('sdk.tsx', readFileSync(new URL('../../components/sdk-provider.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function guardHarness(readStatus: () => Promise<string>) {
  let callback!: ts.Expression;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(providerSource) === 'assertCanDeposit') {
      callback = (node.initializer as ts.CallExpression).arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(providerSource);
  const committedSessionRef: { current: any } = { current: { address: 'owner', chainId: 8453, keystoreManager: {} } };
  const env = {
    committedSessionRef, chainId: 8453, getSdkSetup: async () => ({}),
    resolveKeystoreIdentityStatus: readStatus, setKeystoreIdentityStatus() {}, assertDepositUnlock,
  };
  const guard = new Function(...Object.keys(env), ts.transpileModule(`return (${callback.getText(providerSource)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText)(...Object.values(env));
  return { guard, committedSessionRef };
}

test('the actual deposit callback refuses a failed registration lookup', async () => {
  await expect(guardHarness(async () => 'unknown').guard(8453)).rejects.toThrow('Could not verify');
});

test('the actual deposit callback retains first-registration and compatible flows', async () => {
  for (const state of ['unregistered', 'compatible', 'partial']) {
    await guardHarness(async () => state).guard(8453);
  }
});

test('missing or wrong-network committed sessions cannot authorize a deposit', async () => {
  const h = guardHarness(async () => 'compatible');
  await expect(h.guard(1)).rejects.toThrow('Network changed');
  h.committedSessionRef.current = null;
  await expect(h.guard(8453)).rejects.toThrow('Session is not ready');
});

test('replacing an unlock while its lookup is pending rejects the old result', async () => {
  let finish!: (state: string) => void;
  const h = guardHarness(() => new Promise((resolve) => { finish = resolve; }));
  const pending = h.guard(8453);
  await Promise.resolve();
  h.committedSessionRef.current = { ...h.committedSessionRef.current };
  finish('compatible');
  await expect(pending).rejects.toThrow('Network changed');
});
