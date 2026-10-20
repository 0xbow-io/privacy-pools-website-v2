import { beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { noteCiphertextsFor, recordSnapshotNoteCiphertexts, resetNoteCiphertexts } from '@/services/note-ciphertexts';

const TX = '0xa45c56491a6a66eb0461ec67caf9a90cad622313ab7fcd5d30044f11957ee22d';

beforeEach(() => resetNoteCiphertexts());

test('the pool snapshot is requested with its Note section', () => {
  // snapshot-source pulls in react-native through the API client, so read the
  // request's section list from source rather than importing the module.
  const path = new URL('../snapshot-source.ts', import.meta.url);
  const source = ts.createSourceFile('snapshot-source.ts', readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  let sections: string[] | null = null;
  source.forEachChild((node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const d of node.declarationList.declarations) {
      if (d.name.getText(source) !== 'INCLUDE' || !d.initializer) continue;
      const list = ts.isAsExpression(d.initializer) ? d.initializer.expression : d.initializer;
      if (ts.isArrayLiteralExpression(list)) sections = list.elements.map((e) => (e as ts.StringLiteral).text);
    }
  });
  expect(sections).toEqual(['deposits', 'transacts', 'ragequits', 'notes']);
});

test("a snapshot payload's Note section is recorded for the ownership verdicts", () => {
  const added = recordSnapshotNoteCiphertexts(1, {
    deposits: [],
    notes: [{ txHash: TX, logIndex: 690, hint: '0x01', ephemeralPubKey: '0xaa', encryptedPayload: '0xbb', blockNumber: '26141294', blockTimestamp: null }],
  });
  expect(added).toBe(1);
  expect(noteCiphertextsFor(1, TX)).toEqual([{ ephemeralPubKey: '0xaa', encryptedPayload: '0xbb' }]);
});

test('a payload without a Note section records nothing and never throws', () => {
  expect(recordSnapshotNoteCiphertexts(1, { deposits: [] })).toBe(0);
  expect(recordSnapshotNoteCiphertexts(1, null)).toBe(0);
  expect(recordSnapshotNoteCiphertexts(1, { notes: 'nope' })).toBe(0);
  expect(noteCiphertextsFor(1, TX)).toEqual([]);
});
