import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LOG_SCAN_ALIGNMENT_BLOCKS, alignLogScanStart } from '@/services/log-scan-alignment';

/**
 * The scan cursor is a per-client fingerprint. Passing it raw to eth_getLogs
 * tells the RPC provider roughly when this client last synced, re-identifying a
 * returning client across IP changes. Every client scanning the same region of
 * history must send the same start block.
 *
 * Mirrors the SDK's ViemRPCInteractor alignment tests; keep them in step.
 */

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

describe('alignLogScanStart', () => {
  test('snap a client-specific cursor down onto the shared grid', () => {
    expect(alignLogScanStart(12_345n, 0n)).toBe(10_000n);
  });

  test('map two different cursors in the same window to an identical value', () => {
    expect(alignLogScanStart(12_345n, 0n)).toBe(alignLogScanStart(19_999n, 0n));
  });

  test('distinguish cursors in different windows', () => {
    expect(alignLogScanStart(19_999n, 0n) === alignLogScanStart(20_000n, 0n)).toBe(false);
  });

  test('widen the window rather than narrow it, so no event is missed', () => {
    for (const cursor of [1n, 9_999n, 10_000n, 10_001n, 12_345n, 999_999n]) {
      expect(alignLogScanStart(cursor, 0n) <= cursor).toBe(true);
    }
  });

  test('never return a block before the deployment floor', () => {
    // Aligning 15_900 down gives 10_000, which is before deployment and pure
    // waste. The floor wins.
    expect(alignLogScanStart(15_900n, 15_500n)).toBe(15_500n);
  });

  test('raise a cursor that is below the deployment floor up to the floor', () => {
    expect(alignLogScanStart(100n, 15_500n)).toBe(15_500n);
  });

  test('leave a cursor already on the grid unchanged', () => {
    expect(alignLogScanStart(20_000n, 0n)).toBe(20_000n);
  });

  test('use a grid matching the SDK constant', () => {
    expect(LOG_SCAN_ALIGNMENT_BLOCKS).toBe(10_000n);
  });
});

describe('wiring', () => {
  test('route the chunked RPC scan through alignLogScanStart', () => {
    // A pure-function test proves the maths, not that anything calls it. This
    // pins the call site, so removing it fails here rather than silently
    // restoring the leak.
    const source = readFileSync(join(ROOT, 'services', 'sdk-setup.ts'), 'utf8');
    expect(source.includes('alignLogScanStart(rawFrom, this.deploymentBlock)')).toBe(true);
  });
});
