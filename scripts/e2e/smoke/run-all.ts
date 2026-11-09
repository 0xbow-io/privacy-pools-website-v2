// @ts-nocheck - node/bun process plumbing.
//
// Runs every no-deposit smoke in this directory (*.smoke.ts), one at a time,
// against PROBE_URL, and fails if any of them fails. A new smoke is picked up
// by being here: no workflow edit, so PRs that each add one never collide.
//
//   PROBE_URL=http://localhost:8081 bun scripts/e2e/smoke/run-all.ts [filter]
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const DIR = new URL('.', import.meta.url).pathname;
const filter = process.argv[2];
const smokes = readdirSync(DIR).filter((f) => f.endsWith('.smoke.ts') && (!filter || f.includes(filter))).sort();
if (smokes.length === 0) {
  console.log('no smokes to run');
  process.exit(0);
}
const runner = process.versions.bun ? process.execPath : 'node';
const results: [string, number][] = [];
for (const file of smokes) {
  console.log(`\n===== ${file} =====`);
  const started = Date.now();
  const r = spawnSync(runner, [`${DIR}${file}`], { stdio: 'inherit', env: process.env, timeout: 15 * 60_000 });
  const code = r.status ?? 1;
  results.push([file, code]);
  console.log(`===== ${file}: ${code === 0 ? 'PASS' : `FAIL (${r.signal ?? code})`} in ${Math.round((Date.now() - started) / 1000)}s =====`);
}
const failed = results.filter(([, c]) => c !== 0);
console.log(`\nsmokes: ${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map(([f]) => f).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
