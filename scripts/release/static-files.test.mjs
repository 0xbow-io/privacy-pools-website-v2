import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { files, sha256, publicBuildEnv, verifyCircuits } from './static-files.mjs';

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
