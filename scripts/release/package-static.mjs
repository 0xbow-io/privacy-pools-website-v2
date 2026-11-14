// Runs only inside the pinned builder, after the production export.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { files, sha256, verifyCircuits } from './static-files.mjs';

const input = JSON.parse(readFileSync('/src/release-input.json', 'utf8'));
if (!/^[0-9a-f]{40}$/.test(input.commit) || !Number.isSafeInteger(input.epoch) || input.epoch < 0) throw new Error('Invalid release identity');
const toolchain = {
  node: execFileSync('node', ['--version'], { encoding: 'utf8' }).trim(),
  bun: execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(),
  kubo: execFileSync('ipfs', ['version', '--number'], { encoding: 'utf8' }).trim(),
  builderDockerfileSha256: input.builderDockerfileSha256,
};
if (toolchain.node !== 'v22.23.4' || toolchain.bun !== '1.4.4' || toolchain.kubo !== '0.43.1') throw new Error('Unexpected release toolchain');
await verifyCircuits('/src/dist/artifacts', input.circuits);
mkdirSync('/output', { recursive: true });
mkdirSync('/src/.static-package', { recursive: true });
renameSync('/src/dist', '/src/.static-package/site');
// Subdomain gateways can use this SPA fallback for deep links.
copyFileSync('/src/.static-package/site/index.html', '/src/.static-package/site/404.html');
const inventory = [];
for (const path of files('/src/.static-package/site')) {
  const full = join('/src/.static-package/site', path);
  chmodSync(full, 0o644);
  inventory.push({ path, bytes: statSync(full).size, sha256: await sha256(full) });
}
const ipfsEnv = { ...process.env, IPFS_PATH: '/tmp/release-ipfs' };
const ipfs = args => execFileSync('ipfs', ['--offline', ...args], { env: ipfsEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
ipfs(['init', '--profile=test']);
const siteCid = ipfs(['add', '-Qr', '--cid-version=1', '--raw-leaves=true', '--chunker=size-262144', '--hash=sha2-256', '--inline=false', '--preserve-mode=false', '--preserve-mtime=false', '--hidden=true', '/src/.static-package/site']);
const metadata = { schema: 1, version: input.version, commit: input.commit, sourceDateEpoch: input.epoch, environment: input.environment, toolchain, siteCid, circuits: input.circuits, files: inventory };
writeFileSync('/src/.static-package/release.json', JSON.stringify(metadata, null, 2) + '\n', { mode: 0o644 });
execFileSync('tar', ['--sort=name', `--mtime=@${input.epoch}`, '--owner=0', '--group=0', '--numeric-owner', '--format=gnu', '-cf', '/output/bundle.tar', '-C', '/src/.static-package', 'site', 'release.json'], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
// Stream CAR export: circuits are much larger than the process's output buffer.
const { openSync, closeSync } = await import('node:fs');
const car = openSync('/output/site.car', 'w', 0o644);
try { execFileSync('ipfs', ['--offline', 'dag', 'export', siteCid], { env: ipfsEnv, stdio: ['ignore', car, 'inherit'] }); }
finally { closeSync(car); }
const archiveCid = ipfs(['add', '--only-hash', '-Q', '--cid-version=1', '--raw-leaves=true', '--chunker=size-262144', '--hash=sha2-256', '--inline=false', '/output/bundle.tar']);
const artifacts = [];
for (const path of ['bundle.tar', 'site.car']) {
  const full = join('/output', path), bytes = statSync(full).size;
  if (bytes >= 2 * 1024 ** 3) throw new Error(`${path} exceeds GitHub release asset size limit`);
  artifacts.push({ path, bytes, sha256: await sha256(full) });
}
writeFileSync('/output/release-manifest.json', JSON.stringify({ ...metadata, archiveCid, artifacts }, null, 2) + '\n');
writeFileSync('/output/SHA256SUMS', [...artifacts, { path: 'release-manifest.json', sha256: await sha256('/output/release-manifest.json') }].map(a => `${a.sha256}  ${a.path}\n`).join(''));
rmSync('/tmp/release-ipfs', { recursive: true });
console.log(JSON.stringify({ siteCid, archiveCid, artifacts }));
