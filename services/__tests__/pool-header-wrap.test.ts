import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Artem QA 2026-10-15: on a mid-width pool page the title, the Aave APY pill
// and the chain badge did not fit one line, and the badge was pushed past the
// card edge over the Statistics card. The title group must be able to shrink
// and wrap so the pill drops under the title instead.
const src = readFileSync(join(process.cwd(), 'components/pools/pool-page-header.tsx'), 'utf8');

describe('pool page header wraps instead of overflowing', () => {
  test('title group shrinks and wraps', () => {
    const m = src.match(/testID="pool-header-title-group" className="([^"]+)"/);
    expect(m).not.toBeNull();
    const cls = m![1].split(/\s+/);
    for (const c of ['flex-1', 'min-w-0', 'flex-wrap']) expect(cls).toContain(c);
  });
  test('header row keeps a gap before the chain badge', () => {
    expect(src).toMatch(/className="relative flex-row items-center justify-between gap-\[10px\]/);
  });
});
