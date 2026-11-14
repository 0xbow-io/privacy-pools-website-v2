import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('generated public fee module matches pinned SDK sources and has only lightweight runtime imports', () => {
  const result = spawnSync(process.execPath, ['scripts/stellar/build-fee-module.mjs', '--check'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('runtime imports: @stellar/stellar-sdk, zod');
});
