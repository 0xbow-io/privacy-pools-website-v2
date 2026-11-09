// The (i) beside a yield balance is read aloud as "Balance details". A label
// that led with the pool unit's noun ("Share balance details") put that noun in
// front of every screen-reader user and every aria-label scan.
//
// A unit test on the source and not a browser smoke: the (i) only paints for a
// held yield position, which the smoke wallet does not have. The browser guard
// (scripts/e2e/share-name-guard.ts) reads every aria-label on a page that does
// show one, and scripts/e2e/__tests__/share-name-rules.test.ts pins that the
// old label is a hit.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (name === '__tests__' || name === 'node_modules') return [];
    if (statSync(join(ROOT, rel)).isDirectory()) return sources(rel);
    return /\.(tsx?|jsx?)$/.test(name) ? [rel] : [];
  });
}

describe('the balance hint accessibility label', () => {
  test('the (i) reads "Balance details"', () => {
    expect(read('components/pools/share-count-hint.tsx')).toContain('accessibilityLabel="Balance details"');
  });

  test('no component labels a hint with the pool unit noun in front', () => {
    const offenders = ['components', 'app', 'services']
      .flatMap(sources)
      .filter((file) => /Share balance details/i.test(read(file)));
    expect(offenders).toEqual([]);
  });
});
