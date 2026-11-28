import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the dialog's actual callbacks without rendering Expo/wagmi. This
// covers the merge seam: dev requires a tap, and #73 adds four more buttons.
const source = readFileSync(new URL('../../components/seed-derivation-modal-provider.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('dialog.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string, dependencies: Record<string, unknown>) {
  let found: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === name && node.initializer && ts.isCallExpression(node.initializer)) found = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!found) throw new Error(`Callback ${name} missing`);
  const code = ts.transpileModule(`const invoke = ${found.getText(ast)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), `${code}; return invoke;`)(...Object.values(dependencies)) as () => void;
}
for (const [name, step] of [['takePasskeyBack', undefined], ['takeSecurityKeyOffer', undefined], ['setUpSecurityKey', 'check'], ['confirmCreateSecurityKey', 'create']] as const) {
  test(`${name} carries the user's tap through to the key build`, () => {
    const signs: unknown[][] = [];
    const setup: string[] = [];
    callback(name, {
      choosePasskeyKind: () => true, setSecurityKeyConfirm: () => undefined,
      handleSign: (...args: unknown[]) => { signs.push(args); }, passkeyActive: true,
      requestSecurityKeySetup: (value: string) => { setup.push(value); },
      setErrorMessage: () => { throw new Error('unexpected error'); },
    })();
    expect(signs).toEqual([[undefined, { tap: true }]]);
    expect(setup).toEqual(step ? [step] : []);
  });
}
test('declining the authenticator choice cannot launch a ceremony', () => {
  callback('takeSecurityKeyOffer', {
    choosePasskeyKind: () => false,
    handleSign: () => { throw new Error('must not launch'); },
  })();
});
