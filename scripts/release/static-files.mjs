import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export function files(root, dir = root) {
  return readdirSync(dir).sort().flatMap(name => {
    const path = join(dir, name), stat = lstatSync(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`Non-regular release input: ${path}`);
    return stat.isDirectory() ? files(root, path) : [relative(root, path).split('\\').join('/')];
  });
}
export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function publicBuildEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected public build environment object');
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en'));
  for (const [key, v] of entries) {
    if (!/^EXPO_PUBLIC_[A-Z0-9_]+$/.test(key) || typeof v !== 'string') throw new Error(`Invalid public build setting: ${key}`);
    if (key === 'EXPO_PUBLIC_ARTIFACTS_VERSION' && v !== '') throw new Error('Static releases must use bundled circuits');
  }
  return Object.fromEntries(entries);
}
export async function verifyCircuits(root, entries) {
  if (!entries.some(([p]) => p.endsWith('.zkey')) || !entries.some(([p]) => p.endsWith('.wasm'))) throw new Error('Circuit inventory is empty');
  for (const [path, expected] of entries) {
    if (path.startsWith('/') || path.split('/').includes('..') || !/^[0-9a-f]{64}$/.test(expected)) throw new Error('Invalid circuit inventory');
    const full = join(root, path);
    if (lstatSync(full).size < 200 && readFileSync(full, 'utf8').startsWith('version https://git-lfs.github.com/spec/v1')) throw new Error(`Unhydrated LFS circuit: ${path}`);
    if (await sha256(full) !== expected) throw new Error(`Circuit digest mismatch: ${path}`);
  }
}

/** Re-check disk bytes immediately before publication, not just at build time. */
export async function verifyReleaseOutputs(dir) {
  const manifestPath = join(dir, 'release-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const proof = JSON.parse(readFileSync(join(dir, 'reproducibility.json'), 'utf8'));
  const manifestSha = await sha256(manifestPath);
  if (proof.independentBuilds !== 2 || proof.commit !== manifest.commit || proof.manifestSha256 !== manifestSha) throw new Error('Invalid reproducibility proof');
  const expectedPaths = ['bundle.tar', 'site.car'];
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 2) throw new Error('Invalid release artifact inventory');
  const checksums = [];
  for (const [index, path] of expectedPaths.entries()) {
    const entry = manifest.artifacts[index];
    if (entry.path !== path || entry.sha256 !== await sha256(join(dir, path)) || entry.bytes !== lstatSync(join(dir, path)).size) throw new Error(`Release artifact digest mismatch: ${path}`);
    checksums.push(`${entry.sha256}  ${path}\n`);
  }
  checksums.push(`${manifestSha}  release-manifest.json\n`);
  if (readFileSync(join(dir, 'SHA256SUMS'), 'utf8') !== checksums.join('')) throw new Error('Release checksum list mismatch');
  return { manifest, proof };
}
