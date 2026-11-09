// `bun run build:web`. See scripts/build-mode.mjs for the two modes and
// docs/artifact-hosting.md for the artifacts steps.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { computeArtifactsVersion } from './artifacts-version.mjs';
import { buildMode } from './build-mode.mjs';

const root = new URL('..', import.meta.url).pathname;
const mode = buildMode(process.env);
const bun = process.execPath;
console.log(`[build-web] ${mode} build (VERCEL_ENV=${process.env.VERCEL_ENV ?? 'unset'})`);

function run(command, args, env = {}) {
  const out = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  if (out.status !== 0) process.exit(out.status ?? 1);
}

run(bun, ['run', 'build:worker']);

// On Vercel the artifacts are served by their own project under a versioned path.
const artifactsVersion = process.env.VERCEL ? await computeArtifactsVersion(join(root, 'public', 'artifacts')) : '';
const versionEnv = { EXPO_PUBLIC_ARTIFACTS_VERSION: artifactsVersion };

const exportArgs = ['export', '-p', 'web'];
const exportEnv = { ...versionEnv };
if (mode === 'full') {
  exportArgs.push('--source-maps');
  exportEnv.EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH = '1';
  exportEnv.EXPO_UNSTABLE_TREE_SHAKING = '1';
} else {
  exportArgs.push('--no-minify');
}
run(join(root, 'node_modules', '.bin', 'expo'), exportArgs, exportEnv);

run(bun, ['scripts/artifacts-offload.mjs'], versionEnv);
run(bun, ['scripts/inject-social-meta.mjs']);
run(bun, ['scripts/preload-web-fonts.mjs']);
run(bun, ['scripts/split-web-bootstrap.mjs']);
run(bun, ['scripts/render-landing-document.tsx']);
if (mode === 'full') run(bun, ['scripts/sentry-sourcemaps.mjs']);
