import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// scripts/release/tag-release.sh: what a merge to main tags and publishes.
const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const SCRIPT = join(ROOT, 'scripts/release/tag-release.sh');

const CHANGELOG = `# Changelog

## [2.1.0] - 2026-11-11

### Added
- A thing.

### Fixed
- Another thing.

## [2.0.0] - 2026-11-01

### Changed
- Older notes.

## [1.9.9] - 2026-10-01

## [1x9x8] - 2026-09-01
- Not 1.9.8.
`;

function git(args: string[], cwd?: string) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

/** A package.json + CHANGELOG.md folder and a bare remote, optionally already holding `tag`. */
function fixture(version: string, tag?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'tag-release-'));
  const rootDir = join(dir, 'root');
  const remote = join(dir, 'remote.git');
  git(['init', '-q', rootDir]);
  writeFileSync(join(rootDir, 'package.json'), JSON.stringify({ name: 'x', version }));
  writeFileSync(join(rootDir, 'CHANGELOG.md'), CHANGELOG);
  git(['init', '-q', '--bare', remote]);
  if (tag) {
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], rootDir);
    git(['tag', tag], rootDir);
    git(['push', '-q', remote, `refs/tags/${tag}`], rootDir);
  }
  return { rootDir, remote };
}

/** Only what the script reads: no token or SHA from the test runner leaks in. */
const scriptEnv = (vars: Record<string, string>) => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', ...vars }) as unknown as NodeJS.ProcessEnv;

function run(version: string, tag?: string) {
  const { rootDir, remote } = fixture(version, tag);
  const r = spawnSync('bash', [SCRIPT], {
    cwd: rootDir,
    encoding: 'utf8',
    env: scriptEnv({ TAG_RELEASE_DRY_RUN: '1', TAG_RELEASE_ROOT: rootDir, TAG_RELEASE_REMOTE: remote, GITHUB_SHA: 'abc123' }),
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe('tag-release.sh', () => {
  test('an untagged version would be created at the pushed commit, with exactly its section as notes', () => {
    const r = run('2.1.0');
    expect(r.code).toBe(0);
    expect(r.out).toContain('would create v2.1.0 at abc123 as the latest release');
    const notes = r.out.split('\n').slice(1).join('\n').trim();
    expect(notes).toBe('### Added\n- A thing.\n\n### Fixed\n- Another thing.');
  });

  test('a version already tagged is a no-op', () => {
    const r = run('2.1.0', 'v2.1.0');
    expect(r.code).toBe(0);
    expect(r.out).toContain('v2.1.0 already exists');
    expect(r.out).not.toContain('would create');
  });

  test('an empty or missing section fails loudly', () => {
    for (const v of ['1.9.9', '3.0.0']) {
      const r = run(v);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`no notes under '## [${v}]'`);
    }
  });

  test('the heading is matched literally: 1.9.8 does not take the 1x9x8 section', () => {
    expect(run('1.9.8').code).toBe(1);
  });

  test('a tag lookup that fails stops the run instead of reading as "not tagged"', () => {
    const { rootDir } = fixture('2.1.0');
    const r = spawnSync('bash', [SCRIPT], {
      cwd: rootDir, encoding: 'utf8',
      env: scriptEnv({ TAG_RELEASE_DRY_RUN: '1', TAG_RELEASE_ROOT: rootDir, TAG_RELEASE_REMOTE: join(rootDir, 'no-such-remote.git') }),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not list tags');
    expect(r.stdout).not.toContain('would create');
  });

  test('a version that is not X.Y.Z fails', () => {
    expect(run('2.1').code).toBe(1);
  });
});

describe('the workflow and the old flow', () => {
  const wf = readFileSync(join(ROOT, '.github/workflows/tag-release.yml'), 'utf8');
  test('runs on main and by hand, with contents: write only', () => {
    expect(wf).toContain('branches: [main]');
    expect(wf).toContain('workflow_dispatch:');
    expect(wf).toMatch(/permissions:\n {2}contents: write\n\n/);
    expect(wf).toContain('run: bash scripts/release/tag-release.sh');
  });
  test('every action is pinned by commit', () => {
    for (const uses of wf.match(/uses: \S+/g) ?? []) expect(uses).toMatch(/@[0-9a-f]{40}$/);
  });
  test('release-please is gone', () => {
    for (const f of ['.github/workflows/release-please.yml', 'release-please-config.json', '.release-please-manifest.json']) {
      expect(existsSync(join(ROOT, f))).toBe(false);
    }
  });
});
