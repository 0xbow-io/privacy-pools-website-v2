import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the real prepaint/watchdog opener with provider boundaries stubbed.
const source = ts.createSourceFile('action-hub.tsx', readFileSync('components/home/action-hub.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let tick: ts.VariableDeclaration | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'tick'
    && node.initializer?.getText(source).includes('autoOpenLatest.current')) tick = node;
  ts.forEachChild(node, visit);
}
visit(source);
const code = ts.transpileModule(`return (${tick!.initializer!.getText(source)});`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

for (const action of ['send', 'withdraw']) {
  for (const step of ['success', 'editing']) {
    test(`${action} reopens ${step === 'success' ? 'without its completed amount' : 'with its draft amount'}`, () => {
      const amounts: unknown[] = [];
      const env = {
        navigation: { isFocused: () => true }, actionRef: { current: action },
        autoOpenLatest: { current: { amount: '0.25', tokenSymbol: 'ETH',
          transferStep: step, withdrawStep: step } },
        openWithdrawModal: (_: unknown, options: { amount?: string }) => amounts.push(options.amount),
        openTransferModal: (options: { amount?: string }) => amounts.push(options.amount),
      };
      const run = new Function(...Object.keys(env), code)(...Object.values(env));
      run();
      expect(amounts).toEqual([step === 'success' ? undefined : '0.25']);
      env.navigation.isFocused = () => false;
      run();
      expect(amounts).toHaveLength(1);
    });
  }
}
