import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isRefundSubstatus, recoveredWhere, swapOutcomeTitle } from '../swap-outcome-copy';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

/**
 * DEV-434: the swap success screen kept "Swap submitted" when nothing was
 * deposited, and described a REFUNDED outcome (back on the SOURCE chain) as a
 * payout on the destination chain.
 */
describe('swapOutcomeTitle', () => {
  test('a pending or delivered swap keeps its own title', () => {
    expect(swapOutcomeTitle(null, 'Ethereum', 'Swap submitted')).toBe('Swap submitted');
    expect(swapOutcomeTitle({ status: 'done' }, 'Ethereum', 'Source transaction confirmed')).toBe('Source transaction confirmed');
  });
  test('a recovered swap says it did not deposit, and a refund names the source chain', () => {
    expect(swapOutcomeTitle({ status: 'recovered' }, 'Ethereum', 'Swap submitted')).toBe("Swap didn't deposit");
    expect(swapOutcomeTitle({ status: 'recovered', refunded: true }, 'Ethereum', 'Swap submitted')).toBe('Swap refunded on Ethereum');
    expect(swapOutcomeTitle({ status: 'failed' }, 'Ethereum', 'Swap submitted')).toBe("Swap didn't complete");
  });
});

describe('recoveredWhere', () => {
  test('the chain that actually received the funds', () => {
    expect(recoveredWhere(true, 'Ethereum', 'BNB Chain')).toContain('on Ethereum');
    expect(recoveredWhere(false, 'Ethereum', 'BNB Chain')).toContain('on BNB Chain');
  });
  test('REFUNDED is the refund substatus, PARTIAL is not', () => {
    expect(isRefundSubstatus('REFUNDED')).toBe(true);
    expect(isRefundSubstatus('refunded')).toBe(true);
    expect(isRefundSubstatus('PARTIAL')).toBe(false);
    expect(isRefundSubstatus(undefined)).toBe(false);
  });
});

describe('the swap modal uses them', () => {
  const src = readFileSync(join(ROOT, 'components/swap-modal-provider.tsx'), 'utf8');
  test('both success screens title by outcome, and the poller records a refund', () => {
    expect(src.match(/swapOutcomeTitle\(delivery,/g)?.length).toBe(2);
    expect(src).toContain("refunded: isRefundSubstatus(status.substatus)");
    expect(src).not.toContain('font-pp-sans-bold">Swap submitted</Text>');
    // #155 review: the source chain is the one the tx was SENT on, not the live selection.
    expect(src).toContain('const sourceChainName = getChainConfig(txChainId ?? chainId)');
    expect(src.match(/swapOutcomeTitle\(delivery, sourceChainName,/g)?.length).toBe(2);
  });
});
