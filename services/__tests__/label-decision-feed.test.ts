import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  feedLabelDecisions,
  LABEL_DECISIONS_MAX_AGE_MS,
  readLabelDecisions,
  type LabelDecisions,
} from '@/services/label-decision-feed';

const decisions: LabelDecisions = { rejected: ['0xaa'], poiRequired: [], entrypoint: '0xe' };

describe('readLabelDecisions', () => {
  test('a feed that has never delivered is missing, not empty', () => {
    // The distinction is the whole point: an empty decision set means "nothing
    // is blocked", which is the one answer that must never be guessed.
    expect(readLabelDecisions({ status: 'empty' }, 1_000)).toEqual({ ok: false, reason: 'missing', ageMs: null });
  });

  test('a fresh snapshot is usable, and reports its age', () => {
    const read = readLabelDecisions({ status: 'ready', data: decisions, at: 1_000 }, 1_500);
    expect(read).toMatchObject({ ok: true, decisions, ageMs: 500 });
  });

  // An errored refresh keeps serving the last good value the scheduler held, so
  // one failed tick does not stop a spend — but it ages like any other.
  test('an errored refresh still serves its last good value, until it is too old', () => {
    const errored = { status: 'error', error: new Error('down'), at: 9_000, data: decisions, dataAt: 1_000 } as const;
    expect(readLabelDecisions(errored, 1_500).ok).toBe(true);
    expect(readLabelDecisions(errored, 1_000 + LABEL_DECISIONS_MAX_AGE_MS)).toMatchObject({ ok: false, reason: 'stale' });
  });

  test('an error with nothing behind it is missing', () => {
    expect(readLabelDecisions({ status: 'error', error: new Error('down'), at: 1 }, 2)).toMatchObject({ ok: false, reason: 'missing' });
  });

  // Boundary asserted from both sides: "exactly at the bound" must be refused,
  // or the bound is one tick longer than it reads.
  test('the age bound is exclusive', () => {
    const ready = { status: 'ready', data: decisions, at: 0 } as const;
    expect(readLabelDecisions(ready, LABEL_DECISIONS_MAX_AGE_MS - 1).ok).toBe(true);
    expect(readLabelDecisions(ready, LABEL_DECISIONS_MAX_AGE_MS).ok).toBe(false);
  });

  test('every chain has its own snapshot', () => {
    expect(feedLabelDecisions(1)).not.toBe(feedLabelDecisions(10));
  });
});

// THE RATCHET THAT WOULD HAVE CAUGHT THE ORIGINAL BUG.
//
// no-activity-correlated-polling scans useQuery options and effect bodies, so a
// plain call inside witness construction was invisible to it — which is exactly
// how a fetch ended up one line before every relayed spend. This pins the
// fetcher to its two legitimate homes instead.
describe('only the scheduler may fetch label decisions', () => {
  const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
  const SCANNED = ['services', 'components', 'hooks', 'app'];

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (/\.tsx?$/.test(entry)) out.push(path);
    }
    return out;
  }
  const withoutComments = (source: string) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  test('fetchPoolLabelDecisions is named in exactly two files', () => {
    const files: string[] = [];
    for (const dir of SCANNED) {
      for (const file of walk(join(ROOT, dir))) {
        if (/\bfetchPoolLabelDecisions\b/.test(withoutComments(readFileSync(file, 'utf8')))) {
          files.push(file.slice(ROOT.length + 1));
        }
      }
    }
    // Where it is defined, and where it is registered on the grid. A third file
    // means someone found a way to ask for decisions on demand again.
    expect(files.sort()).toEqual(['services/public-asp-cache.ts', 'services/public-feeds.ts']);
  });

  test('no caller can ask for fresher decisions', () => {
    for (const dir of SCANNED) {
      for (const file of walk(join(ROOT, dir))) {
        const code = withoutComments(readFileSync(file, 'utf8'));
        if (!/getPoolBlockedLabelHashes|getPoolLabelDecisions/.test(code)) continue;
        // The options bag is gone from the signature; an argument that looks
        // like one is a reintroduction attempt.
        expect(code).not.toMatch(/get(PoolBlockedLabelHashes|PoolLabelDecisions)\([^)]*forceFresh/);
        expect(code).not.toMatch(/await\s+getPool(BlockedLabelHashes|LabelDecisions)\(/);
      }
    }
  });
});
