import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseUnits } from 'viem';

import { capText, feeMovedUp, feeOverflowsCap, overCapReason, stableSendMax } from '../send-amount-rules';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const u = (v: string, d = 6) => parseUnits(v, d);

describe('DEV-409: an amount the fee pushes over the cap is gross', () => {
  const cap = u('36.502932');
  const fee = u('0.155523');
  test('Max (equal to the cap) and anything the fee overflows', () => {
    expect(feeOverflowsCap(cap, fee, cap)).toBe(true);
    expect(feeOverflowsCap(u('36.5'), fee, cap)).toBe(true);
    expect(feeOverflowsCap(u('36.4'), fee, cap)).toBe(true);
  });
  test('an amount the fee still fits beside keeps the user\'s choice', () => {
    expect(feeOverflowsCap(u('36.347409'), fee, cap)).toBe(false);
    expect(feeOverflowsCap(u('10'), fee, cap)).toBe(false);
  });
  test('over the cap is a cap error, not gross; no fee known is no decision', () => {
    expect(feeOverflowsCap(u('37'), fee, cap)).toBe(false);
    expect(feeOverflowsCap(u('36.5'), null, cap)).toBe(false);
    expect(feeOverflowsCap(0n, fee, cap)).toBe(false);
  });
});

describe('DEV-437: the cap beside a rejected amount reads smaller than it', () => {
  test('a cap a hair under the entry is shown floored, never as the entry', () => {
    expect(capText(parseUnits('0.004998', 18), parseUnits('0.005', 18), 18)).toBe('0.004998');
    expect(capText(parseUnits('0.00499995', 18), parseUnits('0.005', 18), 18)).toBe('0.004999');
    // Floored, so it can never print as the entry.
    // Still reads below 0.005, never as 0.0050.
    expect(capText(parseUnits('0.0049999999', 18), parseUnits('0.005', 18), 18)).toBe('0.004999');
  });
  test('a dust cap below 0.000001 is shown exact, never as 0', () => {
    expect(capText(5_000_000_000n, parseUnits('0.01', 18), 18)).toBe('0.000000005');
    expect(capText(0n, parseUnits('0.01', 18), 18)).toBe('0');
  });

  test('6-decimal tokens', () => {
    expect(capText(u('36.502932'), u('36.51'), 6)).toBe('36.502932');
    expect(capText(u('36.502932'), u('36.502933'), 6)).toBe('36.502932');
  });
  test('the note caps are named only when they bind', () => {
    expect(overCapReason(u('50'), u('36.5'))).toBe('note-caps');
    expect(overCapReason(u('36.5'), u('36.5'))).toBe('balance');
  });
});

describe('DEV-490: a full-balance send just works, ticked or not', () => {
  const src = readFileSync(join(ROOT, 'components/transfer-modal-provider.tsx'), 'utf8');
  // Evaluate the real maxGrossIntent expression with controlled inputs.
  const start = src.indexOf('const maxGrossIntent = ');
  const expr = src.slice(start + 'const maxGrossIntent = '.length, src.indexOf(');', start) + 1);
  const gross = (receiveExact: boolean, enteredWei: bigint) => new Function(
    'isSui', 'enteredAmountWei', 'maxSpendableWei', 'receiveExact', 'hideAddress', 'isSwapSend', 'feeOverflowsCap', 'relayFeeCeiled',
    `return (${expr});`,
  )(false, enteredWei, u('36.502932'), receiveExact, true, false, feeOverflowsCap, u('0.155523'));

  test('ticked: an amount the fee overflows is netted, not an error', () => {
    expect(gross(true, u('36.5'))).toBe(true);
  });
  test('unticked: the same', () => {
    expect(gross(false, u('36.5'))).toBe(true);
  });
  test('an amount the fee still fits beside keeps the box', () => {
    expect(gross(true, u('30'))).toBe(false);
  });
  test('an exact-cap Max is gross either way', () => {
    expect(gross(true, u('36.502932'))).toBe(true);
  });
  test('the form says so, with what the recipient gets', () => {
    expect(src).toContain('The relayer fee comes out of this amount. The recipient receives');
  });
});

describe('DEV-490: the "Send at most" figure is stable', () => {
  test('taken from the cap minus the binding fee, floored to 6 dp', () => {
    expect(stableSendMax(u('8.670000'), u('1.150000'), 6)).toBe(u('7.52'));
    expect(stableSendMax(parseUnits('1.0000000009', 18), parseUnits('0.1', 18), 18)).toBe(parseUnits('0.9', 18));
  });
  test('never negative, and never 0 when something fits', () => {
    expect(stableSendMax(u('1'), u('2'), 6)).toBe(0n);
    expect(stableSendMax(500_000_000_000n, 100n, 18)).toBe(499_999_999_900n);
  });
  test('a fee that moved up is named', () => {
    expect(feeMovedUp(u('1.1'), u('1.15'))).toBe(true);
    expect(feeMovedUp(u('1.15'), u('1.15'))).toBe(false);
    expect(feeMovedUp(null, u('1.15'))).toBe(false);
  });
  test('the relay guard uses it, not the notes picked for the amount', () => {
    const src = readFileSync(join(ROOT, 'components/transfer-modal-provider.tsx'), 'utf8');
    expect(src).toContain('stableSendMax(maxSpendableWei, quotedRelayFee, selectedDecimals)');
    expect(src).not.toContain('const maxSend = selection.accumulated - quotedRelayFee;');
  });
});

describe('the Send form uses them', () => {
  const src = readFileSync(join(ROOT, 'components/transfer-modal-provider.tsx'), 'utf8');
  test('gross on overflow, floored cap, one-tap max, right reason', () => {
    // Ticked or not since DEV-490.
    expect(src).toContain('(hideAddress && !isSwapSend && feeOverflowsCap(enteredAmountWei, relayFeeCeiled, maxSpendableWei))');
    expect(src).toContain('const effectiveReceiveExact = !maxGrossIntent && resolveEffectiveReceiveExact(');
    expect(src).toContain('capText(maxSpendableWei, enteredAmountWei, selectedDecimals)');
    expect(src).toContain('shareFreeText(amountError, (exact, symbol) => balanceDisplay(exact, symbol, chainId).text)');
    expect(src).toContain('onPress={() => setAmount(maxSpendableFormatted)}');
    expect(src).toContain("`Exceeds your shielded balance of ${cap}`");
    expect(src).not.toContain('parseFloat(maxSpendableFormatted).toFixed(4)');
  });
});
