import { describe, expect, test } from 'bun:test';

import { isYieldSizingRace, prepareSizedAgain, YIELD_SIZING_ATTEMPTS } from '../yield-sizing-race';
import { BUDGET, sdkYieldSizingRefusal as sdkRefusal, sizer } from './yield-sizing-fixture';

describe('yield sizing race (DEV-489, BNB ppUSDT)', () => {
  test('the SDK refuses a stale previewDeposit, and that refusal is recognised', async () => {
    const err = await sdkRefusal();
    expect((err as Error).message).toContain('exceeds the spendable budget 16202583797400000000');
    expect(isYieldSizingRace(err)).toBe(true);
    expect(isYieldSizingRace(new Error('exceeds the spendable budget'))).toBe(false);
  });

  test('sizing again at one block succeeds with no change to the budget', async () => {
    const yieldDeposit = sizer([16_171_136_970_815_352_673n, 16_171_136_958_181_100_995n]);
    const sized = await prepareSizedAgain(() => yieldDeposit.sizeSharesForBudget(BUDGET));
    expect(sized.underlyingNeeded).toBe(16_202_583_797_400_000_000n);
    expect(sized.maxUnderlyingIn).toBe(BUDGET);
  });

  test('gives up after a bounded number of attempts and surfaces the SDK error', async () => {
    let calls = 0;
    const yieldDeposit = sizer([16_171_136_970_815_352_673n]);
    await expect(prepareSizedAgain(() => { calls++; return yieldDeposit.sizeSharesForBudget(BUDGET); }))
      .rejects.toThrow('exceeds the spendable budget');
    expect(calls).toBe(YIELD_SIZING_ATTEMPTS);
  });
});
