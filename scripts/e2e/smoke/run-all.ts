// @ts-nocheck - node/bun process plumbing.
//
// Runs every no-deposit smoke in this directory (*.smoke.ts) against PROBE_URL,
// SMOKE_CONCURRENCY at a time (default 3), and fails if any of them fails. Each
// smoke has its own browser and wallet, so they share nothing but the server.
// A smoke's output is printed whole when it ends, so parallel logs stay readable.
// A new smoke is picked up by being here: no workflow edit, so PRs that each add
// one never collide.
//
//   PROBE_URL=http://localhost:8081 bun scripts/e2e/smoke/run-all.ts [filter]
//   SMOKE_CONCURRENCY=1 runs them one at a time, as before.
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const DIR = new URL('.', import.meta.url).pathname;
const filter = process.argv[2];
const smokes = readdirSync(DIR).filter((f) => f.endsWith('.smoke.ts') && (!filter || f.includes(filter))).sort();
if (smokes.length === 0) {
  console.log('no smokes to run');
  process.exit(0);
}
const runner = process.versions.bun ? process.execPath : 'node';
const concurrency = Math.max(1, Math.floor(Number(process.env.SMOKE_CONCURRENCY ?? 3)) || 1);
const TIMEOUT_MS = 15 * 60_000;

function run(file: string): Promise<[string, number]> {
  return new Promise((resolve) => {
    const started = Date.now();
    const out: Buffer[] = [];
    const child = spawn(runner, [`${DIR}${file}`], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => out.push(d));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      const code = status ?? 1;
      const secs = Math.round((Date.now() - started) / 1000);
      process.stdout.write(`\n===== ${file} =====\n${Buffer.concat(out).toString()}`);
      console.log(`===== ${file}: ${code === 0 ? 'PASS' : `FAIL (${signal ?? code})`} in ${secs}s =====`);
      resolve([file, code]);
    });
  });
}

const queue = [...smokes];
const results: [string, number][] = [];
await Promise.all(
  Array.from({ length: Math.min(concurrency, smokes.length) }, async () => {
    while (queue.length) results.push(await run(queue.shift()!));
  }),
);
const failed = results.filter(([, c]) => c !== 0);
console.log(`\nsmokes: ${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map(([f]) => f).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
