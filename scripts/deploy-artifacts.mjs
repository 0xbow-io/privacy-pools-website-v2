// Publish public/artifacts to the privacy-pools-artifacts Vercel project under
// /artifacts/<version>/. Run it when a circuit changes (almost never), BEFORE the
// app build that picks the new version up (that build refuses to ship otherwise).
//
//   bun scripts/deploy-artifacts.mjs            deploy to production
//   bun scripts/deploy-artifacts.mjs --dry-run  stage only, print the version
//
// Needs `vercel` logged in with access to the 0xbow team, and the real files
// (git lfs pull), not pointers.
import { cpSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeArtifactsVersion } from './artifacts-version.mjs';

const SRC = new URL('../public/artifacts', import.meta.url).pathname;
const STAGE = new URL('../.artifacts-stage', import.meta.url).pathname;
const PROJECT = 'privacy-pools-artifacts';
const SCOPE = '0xbow';

const version = await computeArtifactsVersion(SRC);
if (!version) throw new Error('no artifacts found');

// A pointer file means lfs was skipped: deploying it would publish 130 bytes of text.
const probe = join(SRC, 'transact_1x1', 'groth16_pkey.zkey');
if (statSync(probe).size < 1_000_000) throw new Error('artifacts are lfs pointers, run git lfs pull first');

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(join(STAGE, 'artifacts'), { recursive: true });
// Hard links when the stage is on the same disk, a copy otherwise.
cpSync(SRC, join(STAGE, 'artifacts', version), { recursive: true });
writeFileSync(join(STAGE, 'vercel.json'), JSON.stringify({
  cleanUrls: false,
  headers: [{
    source: '/artifacts/(.*)',
    headers: [
      { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
      { key: 'Access-Control-Allow-Origin', value: '*' },
    ],
  }],
}, null, 2));

console.log(`staged artifacts version ${version} in ${STAGE}`);
if (process.argv.includes('--dry-run')) process.exit(0);

const run = (args) => {
  const out = spawnSync('vercel', args, { cwd: STAGE, stdio: 'inherit' });
  if (out.status !== 0) process.exit(out.status ?? 1);
};
run(['link', '--yes', '--project', PROJECT, '--scope', SCOPE]);
run(['deploy', '--prod', '--yes', '--scope', SCOPE]);
console.log(`published /artifacts/${version}/ on ${PROJECT}`);
