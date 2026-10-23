// Existing lint debt is explicit; no ESLint rules are disabled. Regeneration
// requires a deliberate --baseline-from <git revision>, never the working tree.
import { ESLint } from 'eslint';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { lintFingerprint, newLintMessages } from './lint-baseline-lib.mjs';

const baselinePath = 'scripts/lint-baseline.json';
// Expo's original default scope, plus hooks, services and configuration.
const patterns = ['app/**/*.{js,jsx,ts,tsx}', 'components/**/*.{js,jsx,ts,tsx}', 'hooks/**/*.{js,jsx,ts,tsx}', 'services/**/*.{js,jsx,ts,tsx}', 'config/**/*.{js,jsx,ts,tsx}'];
const eslint = new ESLint({ cache: false });
const current = await eslint.lintFiles(patterns);
const revision = process.argv[2] === '--baseline-from' ? process.argv[3] : null;
if (process.argv.length > 2 && !revision) throw new Error('Usage: bun scripts/lint-baseline.mjs [--baseline-from <git revision>]');
if (revision) {
  const base = execFileSync('git', ['rev-parse', '--verify', `${revision}^{commit}`], { encoding: 'utf8' }).trim();
  const entries = {};
  for (const result of current) {
    const path = relative(process.cwd(), result.filePath);
    let source;
    try { source = execFileSync('git', ['show', `${base}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { continue; } // Newly added files have no allowance.
    const [old] = await eslint.lintText(source, { filePath: result.filePath });
    for (const message of old.messages) {
      const key = lintFingerprint(path, source, message);
      entries[key] = (entries[key] ?? 0) + 1;
    }
  }
  writeFileSync(baselinePath, JSON.stringify({ revision: base, entries: Object.fromEntries(Object.entries(entries).sort()) }, null, 2) + '\n');
  console.log(`Recorded ${Object.values(entries).reduce((a, b) => a + b, 0)} existing diagnostics from ${base}.`);
} else {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  let existing = 0;
  const failures = [];
  for (const result of current) {
    const path = relative(process.cwd(), result.filePath);
    const source = result.source ?? readFileSync(result.filePath, 'utf8');
    const fresh = newLintMessages(path, source, result.messages, baseline.entries);
    existing += result.messages.length - fresh.length;
    if (fresh.length) failures.push({ ...result, messages: fresh, errorCount: fresh.length, warningCount: 0 });
  }
  console.log(`Lint baseline ${baseline.revision}: ${existing} existing diagnostics; ${failures.reduce((n, r) => n + r.messages.length, 0)} new.`);
  if (failures.length) {
    console.log((await eslint.loadFormatter('stylish')).format(failures));
    process.exitCode = 1;
  }
}
