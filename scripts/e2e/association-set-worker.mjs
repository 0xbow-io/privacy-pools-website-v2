// Exercise the built worker and real browser message transport against roots
// computed independently by the pinned SDK on the host. No wallet or live RPC.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { DEPLOYMENTS, MerkleService, PoseidonHashService } from '@privacy-pools-v2/sdk';

const merkle = new MerkleService({ hashService: await PoseidonHashService.create() });
const leaves = [1n, 2n, 3n].map(n => `0x${n.toString(16).padStart(64, '0')}`);
const root = await merkle.computeRoot(leaves);
const changed = [leaves[1], leaves[0], leaves[2]];
const hostRoot = new URL('../..', import.meta.url).pathname;
const bundle = await build({
  stdin: { contents: `import { AssociationSetWorkerClient } from './services/association-set-worker-client'; globalThis.verifier = new AssociationSetWorkerClient();`, resolveDir: hostRoot },
  bundle: true, write: false, format: 'iife', platform: 'browser',
});
const worker = await readFile(new URL('../../public/association-set-worker.js', import.meta.url));
const server = createServer((request, response) => {
  if (request.url === '/association-set-worker.js') response.setHeader('Content-Type', 'application/javascript').end(worker);
  else if (request.url === '/client.js') response.setHeader('Content-Type', 'application/javascript').end(bundle.outputFiles[0].text);
  else response.setHeader('Content-Type', 'text/html').end('<script src="/client.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const result = await page.evaluate(async ({ leaves, changed, root }) => {
    const client = globalThis.verifier;
    const run = async (list, roots, legacy = false, failure) => {
      const calls = [];
      try {
        const value = await client.verify({
          leaves: async () => { calls.push('leaves'); return list; },
          root: async () => { calls.push('root'); if (failure) throw new Error(failure); return roots.shift(); },
        }, legacy);
        return { value, calls };
      } catch (error) { return { error: error.message, calls }; }
    };
    const deployment = await client.deployment(11155111);
    const unknown = await client.deployment(123);
    const values = await Promise.all([
      run(leaves, [root]),
      run(changed, [root, root]),
      run(leaves, ['0x1', root]),
      run(leaves, [root], false, 'RPC offline'),
      run([], ['0x' + '0'.repeat(64), '0x' + '0'.repeat(64)]),
      run([], [], true),
      run(['garbage'], [root]),
      run(Array(262145).fill(leaves[0]), [root]),
    ]);
    let release;
    const pending = client.verify({ leaves: () => new Promise(resolve => { release = resolve; }), root: async () => root }, false);
    while (!release) await new Promise(resolve => setTimeout(resolve, 5));
    client.dispose();
    const disposed = await pending.then(() => false, error => error.constructor.name === 'AssociationSetWorkerUnavailable');
    release(leaves);
    const restarted = await run(leaves, [root]);
    client.dispose();
    return { deployment, unknown, values, disposed, restarted };
  }, { leaves, changed, root });
  assert.deepEqual(result.deployment, DEPLOYMENTS[11155111]);
  assert.equal(result.unknown, undefined);
  const [valid, tampered, advanced, offline, empty, legacy, malformed, oversized] = result.values;
  assert.deepEqual(valid, { value: leaves, calls: ['leaves', 'root'] });
  assert.match(tampered.error, /root mismatch/);
  assert.deepEqual(tampered.calls, ['leaves', 'root', 'root']);
  assert.deepEqual(advanced, { value: leaves, calls: ['leaves', 'root', 'root'] });
  assert.match(offline.error, /RPC offline/);
  assert.deepEqual(offline.calls, ['leaves', 'root']);
  assert.match(empty.error, /root mismatch/);
  assert.deepEqual(empty.calls, ['leaves', 'root', 'root']);
  assert.deepEqual(legacy, { value: [], calls: ['leaves', 'leaves'] });
  assert.match(malformed.error, /valid hexadecimal/);
  assert.deepEqual(malformed.calls, ['leaves']);
  assert.match(oversized.error, /exceeds the maximum of 262144/);
  assert.deepEqual(oversized.calls, ['leaves']);
  assert.equal(result.disposed, true);
  assert.deepEqual(result.restarted, valid);
  assert.deepEqual(errors, []);
  console.log('Built association-set worker: verification, tampering, retry, empty/legacy, limits, concurrency and restart passed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
