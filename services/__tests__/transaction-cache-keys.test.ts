import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { invalidateTransactionCaches, TRANSACTION_CACHE_KEYS } from '../cache';

// Every own write calls invalidateTransactionCaches at confirmation, so any
// query it touches that reaches the network puts a request on the wire timed
// to that transaction. The keys are enumerated from the function itself, and
// each must have a query behind it whose queryFn only reads what this client
// already holds.

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

type Query = { file: string; key: string; queryFn: string };

/** Every `useQuery({ queryKey, queryFn })` with a literal first key element, inline or via a local const. */
function queries(): Query[] {
  const out: Query[] = [];
  for (const path of ['components', 'hooks', 'app'].flatMap((dir) => walk(join(ROOT, dir)))) {
    const file = path.slice(ROOT.length + 1);
    const sf = ts.createSourceFile(file, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const arrays = new Map<string, ts.ArrayLiteralExpression>();
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
        arrays.set(node.name.text, node.initializer);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useQuery'
        && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const props = new Map(node.arguments[0].properties
          .filter(ts.isPropertyAssignment)
          .map((p) => [p.name.getText(sf), p.initializer]));
        let keyExpr = props.get('queryKey');
        if (keyExpr && ts.isIdentifier(keyExpr)) keyExpr = arrays.get(keyExpr.text);
        const first = keyExpr && ts.isArrayLiteralExpression(keyExpr) ? keyExpr.elements[0] : undefined;
        const queryFn = props.get('queryFn');
        if (first && ts.isStringLiteral(first) && queryFn) out.push({ file, key: first.text, queryFn: queryFn.getText(sf) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

// What a queryFn may read through, each established elsewhere as never
// fetching while the feed grid owns its data (snapshot-request-timing.test.ts).
const LOCAL_READERS = ['loadPoolEventSnapshot'];
const NETWORK = /apiClient|\bfetch\(|getVerified|getAssociationSet|getGlobalEvents|fetchSui|getAssetStatistics|readContract|getLogs|getBalance|getBlock|refresh[A-Z]\w*\(|\.get\(/;

describe('a confirmed transaction re-reads local state and asks nothing of the network', () => {
  const found = queries();

  test('the keys come from the declared list, nothing else', async () => {
    const touched: unknown[] = [];
    await invalidateTransactionCaches({ invalidateQueries: async ({ queryKey }: { queryKey: unknown }) => { touched.push(queryKey); } } as never);
    expect(touched).toEqual(TRANSACTION_CACHE_KEYS.map((key) => [...key]));
  });

  for (const key of TRANSACTION_CACHE_KEYS) {
    test(`'${key[0]}' has a query, and every query under it is a pure local read`, () => {
      const matching = found.filter((q) => q.key === key[0]);
      // A key nothing listens on keeps dead code alive and hides the next mistake.
      expect(matching.length).toBeGreaterThan(0);
      for (const q of matching) {
        expect(q.queryFn).not.toMatch(NETWORK);
        expect(LOCAL_READERS.some((reader) => q.queryFn.includes(`${reader}(`))).toBe(true);
      }
    });
  }

  test('the scan sees the network-backed queries it must reject', () => {
    // If the scan stopped finding these, a network-backed key could pass the
    // test above by not being found at all.
    for (const key of ['globalEvents', 'sdkAssociationSetLeaves', 'suiApprovedSet']) {
      const matching = found.filter((q) => q.key === key);
      expect(matching.length).toBeGreaterThan(0);
      expect(matching.some((q) => NETWORK.test(q.queryFn))).toBe(true);
    }
  });
});
