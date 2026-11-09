import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeArtifactsVersion, versionFromEntries } from '../../scripts/artifacts-version.mjs';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function tree(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'artifacts-version-'));
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

describe('artifacts version', () => {
  test('is 12 hex chars and ignores the order of the entries', () => {
    const a = versionFromEntries([['a/x.zkey', sha('1')], ['b/y.wasm', sha('2')]]);
    const b = versionFromEntries([['b/y.wasm', sha('2')], ['a/x.zkey', sha('1')]]);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(a).toBe(b);
  });

  test('changes when one byte of one file changes, or one file moves', () => {
    const base = versionFromEntries([['a/x.zkey', sha('1')], ['b/y.wasm', sha('2')]]);
    expect(versionFromEntries([['a/x.zkey', sha('1!')], ['b/y.wasm', sha('2')]])).not.toBe(base);
    expect(versionFromEntries([['a/z.zkey', sha('1')], ['b/y.wasm', sha('2')]])).not.toBe(base);
  });

  test('an lfs pointer checkout gives the same version as the real files', async () => {
    const real = { 'deposit/groth16_pkey.zkey': 'a'.repeat(300), 'deposit/deposit_js/deposit.wasm': 'b'.repeat(300) };
    const pointers = Object.fromEntries(Object.entries(real).map(([path, content]) => [
      path,
      `version https://git-lfs.github.com/spec/v1\noid sha256:${sha(content)}\nsize ${content.length}\n`,
    ]));
    const realDir = tree(real);
    const pointerDir = tree(pointers);
    try {
      const fromReal = await computeArtifactsVersion(realDir);
      expect(fromReal).toMatch(/^[0-9a-f]{12}$/);
      expect(await computeArtifactsVersion(pointerDir)).toBe(fromReal);
    } finally {
      rmSync(realDir, { recursive: true, force: true });
      rmSync(pointerDir, { recursive: true, force: true });
    }
  });

  test('a missing directory has no version, so a local build stays on flat /artifacts', async () => {
    expect(await computeArtifactsVersion(join(tmpdir(), 'artifacts-version-missing-dir'))).toBe('');
  });
});
