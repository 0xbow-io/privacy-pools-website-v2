// Two isolated production exports. No host .env, API key or build cache enters them.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { collectArtifactEntries, computeArtifactsVersion } from '../artifacts-version.mjs';
import { publicBuildEnv, sha256 } from './static-files.mjs';

const root = resolve(new URL('../..', import.meta.url).pathname);
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git(['status', '--porcelain', '--untracked-files=normal'])) throw new Error('Commit release inputs first; dirty sources cannot identify a release');
const commit = git(['rev-parse', 'HEAD']);
const epoch = Number(git(['show', '-s', '--format=%ct', 'HEAD']));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const environment = publicBuildEnv(JSON.parse(readFileSync(join(root, 'config/release-env.json'), 'utf8')));
const dockerfile = readFileSync(join(root, 'scripts/release/Dockerfile'));
const builderDockerfileSha256 = createHash('sha256').update(dockerfile).digest('hex');
const image = `ppv2-release-builder:${builderDockerfileSha256.slice(0, 16)}`;
const out = join(root, 'release-out');
mkdirSync(out, { recursive: true });
const dockerPrefix = process.argv.includes('--sudo') ? ['sudo', ['-n', 'docker']] : ['docker', []];
async function run(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: root, stdio: 'inherit', ...options });
    proc.on('error', reject);
    proc.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
    if (options.input) proc.stdin.end(options.input);
  });
}
const docker = (args, options) => run(dockerPrefix[0], [...dockerPrefix[1], ...args], options);
await docker(['build', '--platform=linux/amd64', '-t', image, '-'], { stdio: ['pipe', 'inherit', 'inherit'], input: dockerfile });
const circuits = await collectArtifactEntries(join(root, 'public/artifacts'));
const circuitVersion = await computeArtifactsVersion(join(root, 'public/artifacts'));
const cache = join(out, 'circuit-cache');
mkdirSync(cache, { recursive: true });
for (const [path, expected] of circuits) {
  const cached = join(cache, expected);
  if (existsSync(cached) && await sha256(cached) === expected) continue;
  const current = join(root, 'public/artifacts', path);
  if (await sha256(current) === expected) { copyFileSync(current, cached); continue; }
  const origin = JSON.parse(readFileSync(join(root, 'config/artifacts-origin.json'), 'utf8')).default;
  const response = await fetch(`${origin}/artifacts/${circuitVersion}/${path}`);
  if (!response.ok || !response.body) throw new Error(`Circuit download failed: ${path} (${response.status})`);
  const hash = createHash('sha256');
  await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _, done) { hash.update(chunk); done(null, chunk); } }), createWriteStream(cached));
  if (hash.digest('hex') !== expected) { rmSync(cached); throw new Error(`Circuit download digest mismatch: ${path}`); }
}
const input = { commit, epoch, version, environment, builderDockerfileSha256, circuits };
for (const pass of ['first', 'second']) {
  const passRoot = join(out, pass), source = join(passRoot, 'source'), artifacts = join(passRoot, 'artifacts');
  rmSync(passRoot, { recursive: true, force: true });
  mkdirSync(source, { recursive: true }); mkdirSync(artifacts);
  const archive = join(passRoot, 'source.tar');
  git(['archive', '--format=tar', `--output=${archive}`, commit]);
  execFileSync('tar', ['-xf', archive, '-C', source]); rmSync(archive);
  for (const [path, expected] of circuits) copyFileSync(join(cache, expected), join(source, 'public/artifacts', path));
  writeFileSync(join(source, 'release-input.json'), JSON.stringify(input));
  const env = {
    CI: '1', NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=4096',
    EXPO_NO_DOTENV: '1', WEB_BUILD_MODE: 'full', TZ: 'UTC', LC_ALL: 'C',
    SOURCE_DATE_EPOCH: String(epoch), HOME: '/tmp/release-home',
    EXPO_PUBLIC_ARTIFACTS_VERSION: '', ...environment,
  };
  await docker(['run', '--rm', '--platform=linux/amd64', ...(process.argv.includes('--host-network') ? ['--network=host'] : []), '--memory=8g', '--memory-swap=9g', '--cpus=1.8',
    '--user', `${process.getuid()}:${process.getgid()}`, '-v', `${source}:/src`, '-v', `${artifacts}:/output`,
    ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]), image, 'bash', '-c',
    'umask 022 && mkdir -p "$HOME" && NODE_ENV=development bun install --frozen-lockfile && bun run build:web && node scripts/release/package-static.mjs']);
  rmSync(source, { recursive: true });
}
const names = ['bundle.tar', 'site.car', 'release-manifest.json', 'SHA256SUMS'];
for (const name of names) {
  if (await sha256(join(out, 'first/artifacts', name)) !== await sha256(join(out, 'second/artifacts', name))) throw new Error(`NON-REPRODUCIBLE release: ${name}`);
}
const artifacts = join(out, 'artifacts'); mkdirSync(artifacts, { recursive: true });
for (const name of names) copyFileSync(join(out, 'first/artifacts', name), join(artifacts, name));
writeFileSync(join(artifacts, 'reproducibility.json'), JSON.stringify({ commit, independentBuilds: 2, manifestSha256: await sha256(join(artifacts, 'release-manifest.json')) }, null, 2) + '\n');
for (const pass of ['first', 'second']) rmSync(join(out, pass), { recursive: true });
console.log(`Reproduced ${commit}: ${artifacts}`);
