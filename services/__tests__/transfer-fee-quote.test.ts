import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { isAmountRejection } from '../cold-start-claim';
import { assertEgressAllowed, setEgressMode } from '../egress-policy';

const asset = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

function evaluateFile(file: string, env: Record<string, unknown>, exported: string) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const code = source.statements.filter((n) => !ts.isImportDeclaration(n)).map((n) => n.getText(source).replace(/^export /, '')).join('\n');
  return new Function(...Object.keys(env), ts.transpile(`${code}; return ${exported};`, { target: ts.ScriptTarget.ES2022 }))(...Object.values(env));
}

test('the real quote request contains no amount and passes the enforced egress policy', async () => {
  const sent: { url: string; body: unknown }[] = [];
  let feeAmount: unknown = '42500000000000';
  let status = 200;
  let failure = 'unavailable';
  let configured = true;
  setEgressMode('enforce');
  const quote = evaluateFile('services/transfer-fee-quote.ts', {
    getChainConfig: () => configured ? { relayerBaseUrl: 'https://relayer.example' } : undefined,
    policedFetch: async (_party: string, _base: string, url: string, init: RequestInit) => {
      assertEgressAllowed('relayer', { method: String(init.method), url, headers: Object.fromEntries(new Headers(init.headers)), body: String(init.body) });
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(status === 200 ? JSON.stringify({ feeAmount }) : failure, { status });
    },
    AbortSignal,
    isAmountRejection,
  }, '({ quote: fetchTransferFeeQuote, probe: probeTransferFee })');
  const { quote: fetchQuote, probe } = quote;
  expect(await fetchQuote(56, asset)).toBe(42_500_000_000_000n);
  expect(sent).toEqual([{ url: 'https://relayer.example/v1/quote/evm/56/transfer', body: { asset, commit: false } }]);
  for (feeAmount of [null, undefined, -1, '-1', '1.5', 'invalid', 9007199254740992]) {
    expect(await fetchQuote(56, asset)).toBeNull();
  }
  feeAmount = '0';
  expect(await fetchQuote(56, asset)).toBe(0n);
  status = 503;
  expect(await fetchQuote(56, asset)).toBeNull();
  status = 429;
  expect(await fetchQuote(56, asset)).toBeNull();
  status = 400;
  failure = 'amount is below the relay cost';
  expect(await probe(56, asset, 10n)).toBe('rejected');
  expect(sent.at(-1)?.body).toEqual({ asset, amount: '10', commit: false });
  configured = false;
  const count = sent.length;
  expect(await fetchQuote(56, asset)).toBeNull();
  expect(sent).toHaveLength(count);
});
