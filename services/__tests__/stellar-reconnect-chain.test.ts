import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../../components/chain-provider.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('chain-provider.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effect = '';
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
    && node.arguments[0]?.getText(ast).includes('prevStellarAddressRef')) effect = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
if (!effect) throw new Error('Missing Stellar connection effect');
const code = ts.transpileModule(`return (${effect})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

test('Varial A → disconnected → B keeps Stellar selected for reconnect', () => {
  let selected = 1;
  const prev = { current: null as string | null };
  const generation = { current: 0 };
  for (const address of ['wallet-A', null, 'wallet-B']) {
    const env = { prevStellarAddressRef: prev, stellarAddress: address, selectedChainId: selected,
      getChainConfig: (id: number) => ({ chainType: id === 202 ? 'stellar' : 'evm' }),
      STELLAR_OPT_IN: true, isDebugModeActive: () => false, supportedChainIds: [1, 202],
      STELLAR_TESTNET_ID: 202, defaultChainId: 1, switchReqRef: generation,
      setSelectedChainId: (id: number) => { selected = id; },
    };
    new Function(...Object.keys(env), code)(...Object.values(env));
    expect(selected).toBe(202);
  }
  expect(generation.current).toBe(1);
});
