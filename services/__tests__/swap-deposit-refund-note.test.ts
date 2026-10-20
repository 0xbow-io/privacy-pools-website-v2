import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SWAP_DEPOSIT_REFUND_NOTE } from '../swap-deposit-copy';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

/**
 * DEV-436: a swap + deposit returns its unused slippage buffer to the wallet,
 * so the wallet preview reads like a loss ("-28 USDC +0.325 USDT"). Both
 * consent cards say so before anything is signed.
 */
describe('swap + deposit consent explains the slippage refund', () => {
  test('both consent cards render the note', () => {
    for (const file of ['components/deposit-modal-provider.tsx', 'components/home/action-hub.tsx']) {
      expect(readFileSync(join(ROOT, file), 'utf8')).toContain('{SWAP_DEPOSIT_REFUND_NOTE}');
    }
  });
  test('the copy is plain: no em dash, says where the money goes', () => {
    expect(SWAP_DEPOSIT_REFUND_NOTE).not.toContain('—');
    expect(SWAP_DEPOSIT_REFUND_NOTE).toContain('slippage');
    expect(SWAP_DEPOSIT_REFUND_NOTE).toContain('goes into the pool');
  });
});
