import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { files, sha256, publicBuildEnv, verifyCircuits, verifyReleaseOutputs } from './static-files.mjs';

const releaseEnvPath = join(dirname(fileURLToPath(import.meta.url)), '../../config/release-env.json');

// Production runs the egress allowlist in enforce mode. Anything else here makes
// the released bundle send requests that production refuses.
test('release environment enforces the egress policy like production', () => {
  const env = publicBuildEnv(JSON.parse(readFileSync(releaseEnvPath, 'utf8')));
  assert.equal(env.EXPO_PUBLIC_EGRESS_POLICY, 'enforce');
  assert.equal(env.EXPO_PUBLIC_APP_ENV, 'prod');
});

test('release environment is explicit public configuration, never inherited secrets or offloaded circuits', () => {
  assert.deepEqual(publicBuildEnv({ EXPO_PUBLIC_Z: 'true', EXPO_PUBLIC_A: 'prod' }), { EXPO_PUBLIC_A: 'prod', EXPO_PUBLIC_Z: 'true' });
  for (const value of [{ SENTRY_AUTH_TOKEN: 'secret' }, { EXPO_PUBLIC_A: 123 }, { EXPO_PUBLIC_ARTIFACTS_VERSION: 'offloaded' }, null]) assert.throws(() => publicBuildEnv(value));
});
test('circuit inventory rejects LFS pointers, corruption and missing wasm/zkey', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pp-release-'));
  try {
    writeFileSync(join(root, 'prover.wasm'), Buffer.from([0, 97, 115, 109]));
    writeFileSync(join(root, 'key.zkey'), Buffer.from([1, 2, 3, 4]));
    const inventory = await Promise.all(files(root).map(async path => [path, await sha256(join(root, path))]));
    await verifyCircuits(root, inventory);
    await assert.rejects(verifyCircuits(root, []), /inventory/);
    writeFileSync(join(root, 'key.zkey'), 'changed');
    await assert.rejects(verifyCircuits(root, inventory), /digest mismatch/);
    writeFileSync(join(root, 'key.zkey'), 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64));
    await assert.rejects(verifyCircuits(root, inventory), /Unhydrated LFS/);
    await assert.rejects(verifyCircuits(root, [['../key.zkey', 'a'.repeat(64)], ['a.wasm', 'b'.repeat(64)]]), /Invalid circuit/);
  } finally { rmSync(root, { recursive: true }); }
});
test('file inventory is ordered and cannot follow a symlink outside the bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'pp-release-'));
  try {
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'z'), 'z'); writeFileSync(join(root, 'nested/a'), 'a');
    assert.deepEqual(files(root), ['nested/a', 'z']);
    symlinkSync('/etc/passwd', join(root, 'escape'));
    assert.throws(() => files(root), /Non-regular/);
  } finally { rmSync(root, { recursive: true }); }
});

test('publication rechecks artifact bytes, proof binding and checksum list', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pp-publish-'));
  try {
    writeFileSync(join(root, 'bundle.tar'), 'bundle'); writeFileSync(join(root, 'site.car'), 'car');
    const artifacts = [];
    for (const path of ['bundle.tar', 'site.car']) artifacts.push({ path, bytes: path === 'bundle.tar' ? 6 : 3, sha256: await sha256(join(root, path)) });
    const manifest = { commit: 'a'.repeat(40), artifacts };
    writeFileSync(join(root, 'release-manifest.json'), JSON.stringify(manifest));
    const manifestSha256 = await sha256(join(root, 'release-manifest.json'));
    writeFileSync(join(root, 'reproducibility.json'), JSON.stringify({ commit: manifest.commit, independentBuilds: 2, manifestSha256 }));
    writeFileSync(join(root, 'SHA256SUMS'), [...artifacts, { path: 'release-manifest.json', sha256: manifestSha256 }].map(a => `${a.sha256}  ${a.path}\n`).join(''));
    assert.equal((await verifyReleaseOutputs(root)).manifest.commit, manifest.commit);
    writeFileSync(join(root, 'bundle.tar'), 'corrupt');
    await assert.rejects(verifyReleaseOutputs(root), /digest mismatch/);
    writeFileSync(join(root, 'bundle.tar'), 'bundle');
    writeFileSync(join(root, 'SHA256SUMS'), 'changed');
    await assert.rejects(verifyReleaseOutputs(root), /checksum list/);
    writeFileSync(join(root, 'reproducibility.json'), JSON.stringify({ commit: manifest.commit, independentBuilds: 1, manifestSha256 }));
    await assert.rejects(verifyReleaseOutputs(root), /reproducibility proof/);
  } finally { rmSync(root, { recursive: true }); }
});
