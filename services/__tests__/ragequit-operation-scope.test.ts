import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../../components/ragequit-modal-provider.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('ragequit.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function branch(condition: string) {
  let body = '';
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(ast) === condition
      && node.thenStatement.getText(ast).includes('ragequit({')) body = node.thenStatement.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!body) throw new Error('Missing exit branch');
  return ts.transpileModule(`return (async () => ${body})();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

for (const condition of ['isStellar', 'isSui']) {
  test(`${condition} exit completion cannot overwrite a reopened modal`, async () => {
    for (const superseded of [false, true]) {
      let active = true;
      const writes: unknown[] = [];
      let refreshed = 0;
      const submit = async () => { active = !superseded; return { txHash: '0x1', txDigest: '0x1' }; };
      const env = { live: () => active, log: () => {}, selectedNote: { commitment: '0x1' },
        stellarSession: { ragequit: submit }, suiSession: { ragequit: submit, loadNotes: () => [{ commitment: '0x1', coinType: 'SUI' }] },
        setTxHash: (hash: string) => writes.push(hash), setTxChainId: (id: number) => writes.push(id),
        setStep: (step: string) => writes.push(step), setLoadingMessage: () => {},
        STELLAR_TESTNET_ID: 202, SUI_TESTNET_ID: 101, refetchNotes: () => refreshed++,
        invalidateTransactionCaches: async () => {}, queryClient: {}, stellarActionError: String,
      };
      await new Function(...Object.keys(env), branch(condition))(...Object.values(env));
      expect(writes).toEqual(superseded ? [] : ['0x1', condition === 'isStellar' ? 202 : 101, 'success']);
      expect(refreshed).toBe(1);
    }
  });
}

test('a Stellar send finishing after close cannot publish its hash into the reopened modal', async () => {
  const transfer = readFileSync(new URL('../../components/transfer-modal-provider.tsx', import.meta.url), 'utf8');
  const start = transfer.indexOf('        if (live()) { setTxHash(result.txHash);');
  const end = transfer.indexOf('// Local only:', start);
  expect(start).toBeGreaterThan(0);
  const completion = ts.transpileModule(transfer.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const superseded of [false, true]) {
    let epoch = 1;
    const writes: unknown[] = [];
    const pending = Promise.resolve({ txHash: 'stellar-tx' });
    if (superseded) epoch++;
    const result = await pending;
    new Function('live', 'result', 'setTxHash', 'setTxChainId', 'STELLAR_TESTNET_ID', completion)(
      () => epoch === 1, result, (value: unknown) => writes.push(value), (value: unknown) => writes.push(value), 202,
    );
    expect(writes).toEqual(superseded ? [] : ['stellar-tx', 202]);
  }
});
