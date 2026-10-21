// Last post-export step (package.json build:web): give Sentry the source maps
// of the web bundles, then take them out of the deploy.
//
// It runs AFTER every step that rewrites a bundle (split-web-bootstrap writes
// new part files with their own maps), so the debug ids are injected into the
// exact bytes that get served.
//
// With SENTRY_AUTH_TOKEN (Vercel production env): inject debug ids, upload to
// org 0xbow / project v2-app, delete the maps.
// Without it (local, preview): delete the maps and do nothing else.
// `--dry-run`: inject, skip the upload, delete the maps. For local checks,
// since safewrap does not pass env vars through.
import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import SentryCli from '@sentry/cli';

const dist = resolve(process.argv.find((a, i) => i > 1 && !a.startsWith('--')) ?? 'dist');
const dryRun = process.argv.includes('--dry-run');
const token = process.env.SENTRY_AUTH_TOKEN;
const release = process.env.EXPO_PUBLIC_SENTRY_RELEASE;

function mapFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...mapFiles(path));
    else if (name.endsWith('.js.map')) out.push(path);
  }
  return out;
}

const maps = mapFiles(dist);
if (maps.length > 0 && (token || dryRun)) {
  const cli = (args) => execFileSync(SentryCli.getPath(), args, {
    stdio: 'inherit',
    env: { ...process.env, SENTRY_ORG: '0xbow', SENTRY_PROJECT: 'v2-app', SENTRY_URL: 'https://us.sentry.io/' },
  });
  cli(['sourcemaps', 'inject', dist]);
  if (token && !dryRun) {
    cli(['sourcemaps', 'upload', ...(release ? ['--release', release] : []), dist]);
  } else {
    console.log('[sentry-sourcemaps] dry run: injected, upload skipped');
  }
}
for (const map of mapFiles(dist)) rmSync(map);
if (maps.length > 0) console.log(`[sentry-sourcemaps] removed ${maps.length} source maps from ${dist}`);
