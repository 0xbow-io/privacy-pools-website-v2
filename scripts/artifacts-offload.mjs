// Vercel build step: the artifacts are served by their own project, so they must
// not ride along in every deployment (1.2 GB, about 1m40 of every deploy).
//
// Only runs on Vercel (VERCEL=1); a local `expo export` keeps its dist/artifacts.
// Before dropping them it checks that the artifacts project really serves this
// version, so a build can never go live pointing at files that are not there.
import { existsSync, rmSync } from 'node:fs';

const ORIGIN = (process.env.ARTIFACTS_ORIGIN || 'https://privacy-pools-artifacts.vercel.app').replace(/\/+$/, '');
const VERSION = process.env.EXPO_PUBLIC_ARTIFACTS_VERSION?.trim();
const DIST = new URL('../dist/artifacts', import.meta.url).pathname;

if (!process.env.VERCEL) {
  console.log('[artifacts-offload] not on Vercel, keeping dist/artifacts');
  process.exit(0);
}
if (!VERSION) {
  console.error('[artifacts-offload] EXPO_PUBLIC_ARTIFACTS_VERSION is empty on Vercel, refusing to drop the artifacts');
  process.exit(1);
}

// The smallest file of the set is enough: a deployment is atomic.
const probe = `${ORIGIN}/artifacts/${VERSION}/deposit/groth16_pkey.zkey`;
const res = await fetch(probe, { method: 'HEAD' });
if (!res.ok) {
  console.error(`[artifacts-offload] ${probe} answered ${res.status}. Deploy the artifacts first: bun scripts/deploy-artifacts.mjs`);
  process.exit(1);
}

if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
console.log(`[artifacts-offload] served by ${ORIGIN} as /artifacts/${VERSION}, dist/artifacts removed`);
