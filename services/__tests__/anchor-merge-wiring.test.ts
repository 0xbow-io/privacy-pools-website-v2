import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

const GUARDED_MEMOS = [
  'components/accounting-modal-provider.tsx',
  'components/pools/transactions.tsx',
  'components/pools/pool-page-content.tsx',
];

function dependencyListForAnchorMerge(source: string): string {
  const marker = source.indexOf('data.anchorTxHashes');
  expect(marker).toBeGreaterThan(-1);

  const memoStart = source.lastIndexOf('useMemo', marker);
  const callStart = source.lastIndexOf('mergeMyTransactions', marker);
  expect(memoStart).toBeGreaterThan(-1);
  expect(callStart).toBeGreaterThan(memoStart);

  const depsStart = source.indexOf('}, [', marker);
  expect(depsStart).toBeGreaterThan(marker);
  const depsEnd = source.indexOf(']);', depsStart);
  expect(depsEnd).toBeGreaterThan(depsStart);
  return source.slice(depsStart, depsEnd);
}

describe('anchor stamp merge wiring', () => {
  test('every React memo that passes anchor hashes into mergeMyTransactions depends on them', () => {
    const offenders: string[] = [];

    for (const rel of GUARDED_MEMOS) {
      const source = readFileSync(join(ROOT, rel), 'utf8');
      const deps = dependencyListForAnchorMerge(source);
      if (!deps.includes('data.anchorTxHashes')) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });

  test('relayed receipt-link claims verify expected nullifiers before stamping an anchor', () => {
    const rel = 'hooks/use-note-import.ts';
    const source = readFileSync(join(ROOT, rel), 'utf8');
    const receiptStart = source.indexOf('receipt = relayed.mode === ');
    expect(receiptStart).toBeGreaterThan(-1);

    const stampCall = source.indexOf('recordAnchorStamps(', receiptStart);
    expect(stampCall).toBeGreaterThan(receiptStart);

    const confirmationBlock = source.slice(receiptStart, stampCall);
    expect(confirmationBlock.includes('extractSpentNullifiers')).toBe(true);
    expect(confirmationBlock.includes('confirmRelayedSpend')).toBe(true);
    expect(confirmationBlock.includes('anchorConfirmed = false')).toBe(true);
  });
});
