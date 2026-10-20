import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const SRC = readFileSync(join(ROOT, 'components/transfer-modal-provider.tsx'), 'utf8');

/**
 * DEV-411: with no wallet (and no account key) the Send form showed
 * "Maximum sendable … ≈ 0.0000" and a "Continue in Swap" button. The limits
 * were gated in 799fa547; the button now asks to connect.
 */
describe('Send with no wallet', () => {
  test('limits stay quiet without an account', () => {
    expect(SRC).toContain('if (!connectedAddress) return null;');
    expect(SRC).toContain('{!!connectedAddress && enteredAmount > 0 && enteredAmountWei > maxSpendableWei && (');
  });

  test('the primary button reads "Connect wallet" and opens the connect flow', () => {
    expect(SRC).toContain("const needsConnect = !isSui && !connectedAddress && identityMode !== 'key';");
    expect(SRC).toContain('if (needsConnect) { ensureConnected(); return; }');
    const label = SRC.indexOf('{needsConnect\n                        ? \'Connect wallet\'');
    expect(label).toBeGreaterThan(-1);
    // Before any route label (Continue in Swap / Withdraw, Review Transfer).
    expect(label).toBeLessThan(SRC.indexOf("'Continue in Swap') : 'Review Transfer'}"));
  });
});
