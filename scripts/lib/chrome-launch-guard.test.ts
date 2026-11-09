import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const ALLOWED = 'scripts/lib/chrome.mjs';
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.expo', 'dist', 'build', 'ios', 'android', 'target']);
const EXTENSIONS = /\.(ts|tsx|mjs|js|cjs|sh|yml|yaml)$/;
const BANNED = [
  { name: 'a --no-sandbox flag', pattern: /--no-sandbox/ },
  { name: 'a --disable-setuid-sandbox flag', pattern: /--disable-setuid-sandbox/ },
  { name: 'a bare chromium.launch', pattern: /chromium\s*\.\s*launch\w*\s*\(/ },
];

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) yield* walk(full);
    else if (EXTENSIONS.test(entry)) yield full;
  }
}

describe('browser launch guard', () => {
  test('only scripts/lib/chrome.mjs launches Chromium or names a sandbox-off flag', () => {
    const self = relative(ROOT, import.meta.path);
    const offenders: string[] = [];
    for (const file of walk(ROOT)) {
      const rel = relative(ROOT, file);
      if (rel === ALLOWED || rel === self) continue;
      const text = readFileSync(file, 'utf8');
      for (const { name, pattern } of BANNED) {
        if (pattern.test(text)) offenders.push(`${rel}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
