import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseUnits } from 'viem';

import { payrollFeePreviewText } from '@/components/payroll/io';
import { sendFeeMode } from '@/services/send-amount-rules';
import { resolveEffectiveReceiveExact } from '@/services/withdraw-quotes';
import { splitRelayFee, ceilFeeToDisplayGrain } from '@/services/relay-fee-split';
import { relayFeeText, type ShareRate } from '@/services/share-rates';

// Matthew's review on #78.
// P2: when the balance covers the salary but not the salary plus the fee, Send
// took the fee out of the payment: the payee got less and the row stayed unpaid.
// An untouched payroll amount with "Recipient receives the exact amount" keeps
// the fee on top, so the form shows the insufficient-balance error instead.
// P3: the payroll fee preview uses Send's fee formatter, so one fee reads the
// same on both screens.

const D = 18;
const u = (s: string) => parseUnits(s, D);
const SALARY = u('1000');
const FEE = u('0.08');
const mode = (over: Partial<Parameters<typeof sendFeeMode>[0]> = {}) => sendFeeMode({
  enteredWei: SALARY, capWei: u('1000.05'), feeWei: FEE, requestedReceiveExact: true,
  callerAmountUntouched: true, relayedSend: true, resolveReceiveExact: resolveEffectiveReceiveExact, ...over,
});
/** What the payee receives and whether the form would refuse (relayFeeExceeds), as the modal derives them. */
function outcome(m: ReturnType<typeof sendFeeMode>, entered = SALARY, cap = u('1000.05')) {
  const sendExact = !m.effectiveReceiveExact;
  const split = splitRelayFee({ entered, feeWei: FEE, grain: 1n, sendExact });
  return { recipientWei: split.recipientWei, refused: !sendExact && entered + FEE > cap };
}

describe('P2: an untouched payroll salary keeps the fee on top', () => {
  test('balance covers the salary but not the fee: refused, never paid short', () => {
    const fixed = outcome(mode());
    expect(fixed.refused).toBe(true);
    // The ordinary rule (what payroll got before) would net the fee out of the salary.
    const before = outcome(mode({ callerAmountUntouched: false }));
    expect(before.refused).toBe(false);
    expect(before.recipientWei).toBeLessThan(SALARY);
  });

  test('salary equal to the whole balance: still fee on top, refused', () => {
    const m = mode({ capWei: SALARY });
    expect(m.maxGrossIntent).toBe(false);
    expect(outcome(m, SALARY, SALARY).refused).toBe(true);
  });

  test('enough for salary and fee: the payee gets exactly the salary', () => {
    const r = outcome(mode({ capWei: u('2000') }), SALARY, u('2000'));
    expect(r.refused).toBe(false);
    expect(r.recipientWei).toBe(SALARY);
  });

  test('ordinary Send and MAX are unchanged: a full-balance entry nets the fee out', () => {
    const m = mode({ callerAmountUntouched: false, capWei: SALARY });
    expect(m.maxGrossIntent).toBe(true);
    expect(m.effectiveReceiveExact).toBe(false);
  });

  test('an explicit choice wins: unticking the box sends exact (fee out of the amount)', () => {
    const m = mode({ requestedReceiveExact: false });
    expect(m.effectiveReceiveExact).toBe(false);
    expect(outcome(m).refused).toBe(false);
  });
});

describe('P2 wiring in the transfer modal (source guard)', () => {
  const modal = readFileSync(new URL('../../components/transfer-modal-provider.tsx', import.meta.url), 'utf8');
  test('the fee mode comes from sendFeeMode with the untouched caller amount', () => {
    expect(modal).toContain('const callerAmountUntouched = callerAmount !== null && amount === callerAmount;');
    expect(modal).toContain('callerAmountUntouched,\n    relayedSend: hideAddress && !isSwapSend,');
    expect(modal).toContain('const maxGrossIntent = !isSui && feeMode.maxGrossIntent;');
  });
  test('the caller amount is recorded where the coin amount lands, and dropped on open and close', () => {
    expect(modal).toContain('if (shares) { setAmount(shares); setCallerAmount(shares); }');
    expect(modal).toContain('setAmount(plain);\n    setCallerAmount(plain);');
    expect(modal.match(/convertedAtRef\.current = null;\n    setCallerAmount\(null\);/g)?.length).toBe(2);
  });
});

describe('P3: the payroll fee preview reads like the Send fee line', () => {
  const ppUSDT: ShareRate = {
    chainId: 1, share: '0xshare', underlying: '0xusdt', shareSymbol: 'ppUSDT', shareDecimals: 18,
    assetsPerShare: 1_005_420n, underlyingSymbol: 'USDT', underlyingDecimals: 6,
  };
  const units = { symbol: 'ppUSDT', decimals: 18 };
  // A fee whose USDT value is 0.0751..., which a rounded-down writer shows as 0.07.
  const fee = parseUnits('0.0747', 18);
  const exact = (wei: bigint) => `~${wei}`;

  test('the same fee gives the same text as Send (rounded up)', () => {
    const send = relayFeeText(ceilFeeToDisplayGrain(fee, 18), units, ppUSDT, exact);
    expect(payrollFeePreviewText(fee, units, ppUSDT, exact)).toBe(send);
    expect(send).toBe('~0.08 USDT');
  });

  test('run.tsx uses it, not the balance writer, for the fee', () => {
    const run = readFileSync(new URL('../../components/payroll/run.tsx', import.meta.url), 'utf8');
    expect(run).toContain('payrollFeePreviewText(fee,');
    expect(run).not.toContain('feeDisplay(formatUnits(ceilFeeToDisplayGrain(fee');
  });
});
