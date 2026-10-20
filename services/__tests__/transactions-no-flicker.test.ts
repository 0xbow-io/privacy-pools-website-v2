// My transactions flickered on every refresh with nothing new in it (Pat,
// 2026-09-25): a no-op notes poll made classification re-run, which hid and
// re-showed rows, and rows keyed by position remounted whenever the list moved.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { contentKey } from '@/services/content-key';
import { stableRowKeys } from '@/services/row-keys';

const here = new URL('.', import.meta.url).pathname;
const source = (p: string) => readFileSync(join(here, '..', '..', p), 'utf8');

describe('contentKey', () => {
  test('two rebuilds of the same notes give the same key, bigints included', () => {
    const a = [{ commitment: '0x1', value: 5n, status: 'ACTIVE' }];
    const b = [{ commitment: '0x1', value: 5n, status: 'ACTIVE' }];
    expect(a).not.toBe(b);
    expect(contentKey(a)).toBe(contentKey(b));
  });

  test('any changed field changes the key', () => {
    const base = { commitment: '0x1', value: 5n, status: 'ACTIVE' };
    expect(contentKey([base])).not.toBe(contentKey([{ ...base, status: 'SPENT' }]));
    expect(contentKey([base])).not.toBe(contentKey([{ ...base, value: 6n }]));
    // A bigint is not confused with the same digits as a string.
    expect(contentKey([{ v: 5n }])).not.toBe(contentKey([{ v: '5' }]));
  });
});

describe('stableRowKeys', () => {
  const base = (r: { type: string; id: string }) => `${r.type}-${r.id}`;

  test('a row keeps its key when a newer row arrives above it', () => {
    const old = [{ type: 'Deposit', id: 'a' }, { type: 'Withdrawal', id: 'b' }];
    const next = [{ type: 'Transfer', id: 'c' }, ...old];
    const before = stableRowKeys(old, base);
    const after = stableRowKeys(next, base);
    expect(after.slice(1)).toEqual(before);
  });

  test('repeated identities still get distinct keys', () => {
    const keys = stableRowKeys([{ type: 'Transfer', id: 'x' }, { type: 'Transfer', id: 'x' }], base);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('wiring', () => {
  test('classification is pinned to a content-stable notes array', () => {
    const provider = source('components/pools-provider.tsx');
    expect(provider).toContain('const freshSpendNotesKey = useMemo(() => contentKey(freshSpendNotes), [freshSpendNotes]);');
    expect(provider).toContain('const spendNotes = useContentStable(freshSpendNotes, freshSpendNotesKey);');
    expect(provider).toContain('userSpends.forNotes === spendNotes');
  });

  test('table rows are keyed by identity, and the pulse wrapper never changes type', () => {
    const table = source('components/pools/transactions.tsx');
    expect(table).toContain('<View key={rowKey}');
    expect(table).not.toMatch(/key=\{`\$\{tx\.type\}-\$\{tx\.id\}-\$\{index\}`\}/);
    expect(table).not.toContain('if (!pulsing) return <>{children}</>;');
  });
});

describe('row identity', () => {
  test('the key does not move when a row is reclassified', () => {
    const table = source('components/pools/transactions.tsx');
    expect(table).toContain('const rowKeys = stableRowKeys(transactions, (tx) => String(tx.id));');
    const before = stableRowKeys([{ type: 'Transfer In', id: 't1' }], (r) => String(r.id));
    const after = stableRowKeys([{ type: 'Transfer Out', id: 't1' }], (r) => String(r.id));
    expect(after).toEqual(before);
  });
});
