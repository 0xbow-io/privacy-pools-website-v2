import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { files, sha256, publicBuildEnv, verifyCircuits, verifyReleaseOutputs, RELEASE_ASSETS } from './static-files.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const releaseEnvPath = join(here, '../../config/release-env.json');
const workflow = readFileSync(join(here, '../../.github/workflows/static-release.yml'), 'utf8');

/** Split the workflow into its top-level header and one text block per job. */
function workflowParts(text) {
  const lines = text.split('\n');
  const jobsAt = lines.indexOf('jobs:');
  assert.ok(jobsAt > 0, 'workflow has a jobs section');
  const jobs = {};
  let current;
  for (const line of lines.slice(jobsAt + 1)) {
    const name = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)?.[1];
    if (name) jobs[(current = name)] = [];
    else if (current) jobs[current].push(line);
  }
  return { header: lines.slice(0, jobsAt).join('\n'), jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')])) };
}

// Every main push runs this workflow. Only a release may pay for LFS and full
// history, and a non-release run must not be able to replace a queued release run.
test('static release decides cheaply before the LFS build', () => {
  const { header, jobs } = workflowParts(workflow);
  assert.deepEqual(Object.keys(jobs), ['decide', 'publish']);
  assert.doesNotMatch(header, /^concurrency:/m, 'no workflow-level concurrency group');
  assert.doesNotMatch(jobs.decide, /lfs:\s*true/);
  assert.match(jobs.decide, /lfs:\s*false/);
  assert.match(jobs.decide, /filter:\s*blob:none/);
  assert.doesNotMatch(jobs.decide, /concurrency:/);
  assert.match(jobs.decide, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \|\| inputs\.tag \}\}/);
  assert.match(jobs.decide, /refs\/tags\/\$tag/);
  assert.match(jobs.decide, /"\$\(git rev-parse "\$tag\^\{commit\}"\)" != "\$\(git rev-parse HEAD\)"/);
  assert.match(jobs.decide, /git merge-base --is-ancestor HEAD origin\/main/);
  assert.match(jobs.publish, /^ {4}needs: decide$/m);
  assert.match(jobs.publish, /^ {4}if: needs\.decide\.outputs\.tag != ''$/m);
  assert.match(jobs.publish, /lfs:\s*true/);
  assert.match(jobs.publish, /ref: \$\{\{ needs\.decide\.outputs\.sha \}\}/);
  assert.match(jobs.publish, /concurrency:\n\s+group: reproducible-static-release-\$\{\{ needs\.decide\.outputs\.tag \}\}\n\s+cancel-in-progress: false/);
  for (const job of Object.values(jobs)) {
    assert.equal((job.match(/persist-credentials: false/g) ?? []).length, (job.match(/actions\/checkout@/g) ?? []).length);
  }
  const build = jobs.publish.split('- name: Build twice')[1].split('- name:')[0];
  assert.doesNotMatch(build, /TOKEN/);
});

test('release assets upload the manifest-binding files last', () => {
  assert.deepEqual([...RELEASE_ASSETS].sort(), ['SHA256SUMS', 'bundle.tar', 'release-manifest.json', 'reproducibility.json', 'site.car']);
  assert.deepEqual(RELEASE_ASSETS.slice(-2), ['reproducibility.json', 'SHA256SUMS']);
  const publish = readFileSync(join(here, 'publish-static.mjs'), 'utf8');
  assert.match(publish, /for \(const name of RELEASE_ASSETS\)/);
  assert.doesNotMatch(publish, /'bundle\.tar'/, 'no second inline asset list');
});

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
