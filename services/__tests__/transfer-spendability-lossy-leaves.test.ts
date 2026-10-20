import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

// QA 2026-10-15, BNB Chain: the portfolio showed 0.02893 BNB while the
// payment-request preflight treated only 0.0011 BNB as spendable. A holed
// getStateLeaves() fetch (lossy eth_getLogs) must never drop a note the index
// already proved. Run in a child process: Bun module mocks leak across files.
test('keeps index-proven notes whose leaf the lossy fetch lost', () => {
  const run = spawnSync(process.execPath, ['services/__tests__/fixtures/transfer-spendability-lossy-leaves.case.ts'], { encoding: 'utf8' });
  expect(run.status).toBe(0);
  const out = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}');
  expect(out.rejectCodes).toEqual([]);
  expect(out.total).toBe('29098148975083278');
});
