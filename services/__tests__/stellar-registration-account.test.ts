import { test } from 'bun:test';
import { spawnSync } from 'node:child_process';

// The account registers a global debug snapshot and imports React Native.
// Isolate its native and SDK mocks from the rest of the unit suite.
test('Stellar account registration integration', () => {
  const result = spawnSync(process.execPath, ['test', new URL('./fixtures/stellar-registration-account.fixture.ts', import.meta.url).pathname], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
});
