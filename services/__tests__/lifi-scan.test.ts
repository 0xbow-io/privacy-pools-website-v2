// A cross-chain leg shows a LI.FI Scan link while the bridge is in flight
// (services/lifi-scan.ts), so a slow delivery can be watched.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lifiScanUrl, LIFI_SCAN_TX_BASE } from '@/services/lifi-scan';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const HASH = `0x${'ab'.repeat(32)}`;

describe('lifiScanUrl', () => {
  test('a source tx hash becomes its LI.FI Scan page', () => {
    expect(lifiScanUrl(HASH)).toBe(`https://scan.li.fi/tx/${HASH}`);
    expect(LIFI_SCAN_TX_BASE).toBe('https://scan.li.fi/tx/');
  });

  test('anything that is not a tx hash gets no link', () => {
    for (const bad of [null, undefined, '', '0x1234', `0x${'zz'.repeat(32)}`, `${HASH}00`, 'https://evil.example/0x']) {
      expect(lifiScanUrl(bad)).toBeNull();
    }
  });
});

describe('the flows show it while the bridge runs', () => {
  test('cross-chain shield: set when the watch starts, kept on every update, shown while pending', () => {
    const deposit = readFileSync(join(ROOT, 'components/deposit-modal-provider.tsx'), 'utf8');
    const hub = readFileSync(join(ROOT, 'components/home/action-hub.tsx'), 'utf8');
    // A direct Across deposit is not on LI.FI Scan, so the link is kept for LI.FI routes only.
    expect(deposit).toMatch(/const scan = bridge \? null : lifiScanUrl\(String\(swapHash\)\);/);
    expect(deposit.match(/\.\.\.\(scan \? \{ lifiScanUrl: scan \} : \{\}\)/g)?.length).toBe(3);
    expect(hub).toMatch(/bridgeProgress\?\.tone === 'pending' && depositFlow\.bridgeProgress\.lifiScanUrl/);
  });

  test('cross-chain swap and swap-send: shown on both receipts while delivery is pending', () => {
    const swap = readFileSync(join(ROOT, 'components/swap-modal-provider.tsx'), 'utf8');
    expect(swap).toMatch(/const lifiScanLink = delivery\?\.status === 'pending' && !delivery\.bridge \? lifiScanUrl\(txHash\) : null;/);
    expect(swap.match(/testID="bridge-lifi-scan-link"/g)?.length).toBe(2);
  });
});
