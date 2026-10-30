// Publish public/artifacts to the privacy-pools-artifacts Vercel project under
// /artifacts/<version>/. Run it when a circuit changes (almost never). It is
// ADDITIVE: the versions already published stay served (see artifacts-manifest.mjs),
// so the live app, a rollback and open PRs keep working while a new one goes out.
// Publish BEFORE the app build that picks the new version up: that build refuses to
// ship until the artifacts project serves its version.
//
//   node scripts/deploy-artifacts.mjs            deploy to production
//   node scripts/deploy-artifacts.mjs --dry-run  stage only, print the version
//   node scripts/deploy-artifacts.mjs --check-only  is this version already served? (no lfs needed)
//
// Needs `vercel` logged in with access to the 0xbow team, and the real files
// (git lfs pull), not pointers.
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectArtifactEntries, versionFromEntries } from './artifacts-version.mjs';
import { artifactsVercelConfig, blobShas, mergeManifests } from './artifacts-manifest.mjs';

const SRC = new URL('../public/artifacts', import.meta.url).pathname;
const STAGE = new URL('../.artifacts-stage', import.meta.url).pathname;
const PROJECT = 'privacy-pools-artifacts';
const SCOPE = '0xbow';
const DEFAULT_ORIGIN = JSON.parse(readFileSync(new URL('../config/artifacts-origin.json', import.meta.url), 'utf8')).default;
const envOrigin = process.env.EXPO_PUBLIC_ARTIFACTS_ORIGIN?.trim().replace(/\/+$/, '') ?? '';
const ORIGIN = envOrigin.startsWith('https://') ? envOrigin : DEFAULT_ORIGIN;

const entries = await collectArtifactEntries(SRC);
if (entries.length === 0) throw new Error('no artifacts found');
const version = versionFromEntries(entries);
const files = Object.fromEntries(entries);

// Is this version already served? Decided from the content hashes alone, so a
// checkout that skipped lfs can ask it too (the .github/workflows/artifacts.yml job
// does, and only fetches the 1.2 GB when the answer is no).
const probe = await fetch(`${ORIGIN}/artifacts/${version}/deposit/groth16_pkey.zkey`, { method: 'HEAD' });
const published = probe.ok;
if (process.argv.includes('--check-only')) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `needed=${!published}\nversion=${version}\n`);
  console.log(`version ${version} ${published ? 'is already published' : 'needs publishing'}`);
  process.exit(0);
}

// A pointer file means lfs was skipped: deploying it would publish 130 bytes of text.
if (statSync(join(SRC, 'transact_1x1', 'groth16_pkey.zkey')).size < 1_000_000) {
  throw new Error('artifacts are lfs pointers, run git lfs pull first');
}

// The versions already live. The list is a file of the project itself; none yet is fine.
let existing = {};
const listed = await fetch(`${ORIGIN}/artifacts/manifests.json`, { cache: 'no-store' });
if (listed.ok) existing = await listed.json();
else if (listed.status !== 404) throw new Error(`cannot read ${ORIGIN}/artifacts/manifests.json: ${listed.status}`);
const manifests = mergeManifests(existing, version, files);

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, 'blobs'), { recursive: true });
mkdirSync(join(STAGE, 'artifacts'), { recursive: true });

// One stored file per distinct content. A blob this checkout has comes from disk,
// one only an older version has is downloaded from the live project and verified.
const local = new Map(entries.map(([path, sha]) => [sha, join(SRC, path)]));
let downloaded = 0;
for (const sha of blobShas(manifests)) {
  const target = join(STAGE, 'blobs', sha);
  const from = local.get(sha);
  if (from) {
    try { linkSync(from, target); } catch { copyFileSync(from, target); }
    continue;
  }
  const res = await fetch(`${ORIGIN}/blobs/${sha}`);
  if (!res.ok) throw new Error(`blob ${sha} of an older version is gone from ${ORIGIN} (${res.status})`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error(`blob ${sha} came back with other content`);
  writeFileSync(target, bytes);
  downloaded += 1;
}

writeFileSync(join(STAGE, 'artifacts', 'manifests.json'), JSON.stringify(manifests));
writeFileSync(join(STAGE, 'vercel.json'), JSON.stringify(artifactsVercelConfig(manifests), null, 2));

const kept = Object.keys(manifests);
console.log(`staged version ${version}, serving ${kept.length} versions (${kept.join(', ')}), ${downloaded} older blobs fetched`);
if (process.argv.includes('--dry-run')) process.exit(0);

// CI has no login: a team token comes in through VERCEL_TOKEN and is passed as a flag.
const tokenArgs = process.env.VERCEL_TOKEN ? ['--token', process.env.VERCEL_TOKEN] : [];
const run = (args) => {
  const out = spawnSync('vercel', [...args, ...tokenArgs], { cwd: STAGE, stdio: 'inherit' });
  if (out.status !== 0) process.exit(out.status ?? 1);
};
run(['link', '--yes', '--project', PROJECT, '--scope', SCOPE]);
run(['deploy', '--prod', '--yes', '--scope', SCOPE]);
console.log(`published /artifacts/${version}/ on ${PROJECT}`);
