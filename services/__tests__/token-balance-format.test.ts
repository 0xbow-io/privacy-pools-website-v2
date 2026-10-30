import { describe, expect, test } from 'bun:test';

import { amountInputDisplay, formatTokenBalance, formatTokenBalanceDown, groupThousands, stripAmountSeparators } from '@/services/token-format';

// This helper carries the whole app's "does the user think they have zero"
// question: balances, activity rows and pool tables all print through it.
describe('formatTokenBalance', () => {
  test('a positive amount is never printed as zero or as a range', () => {
    // cBTC tracks BTC, so an ordinary test amount is this small. It used to
    // read "0.0000 cBTC", then "<0.00001"; the user holds an exact figure.
    expect(formatTokenBalance(0.000004, 'cBTC')).toBe('0.000004');
    expect(formatTokenBalance(0.0000041234, 'cBTC')).toBe('0.0000041');
    expect(formatTokenBalance(1e-9, 'ETH')).toBe('0.000000001');
    expect(formatTokenBalance(0.004, 'USDT')).toBe('0.004');
    expect(formatTokenBalance(0.00412, 'USDC')).toBe('0.0041');
  });

  test('a test-sized amount keeps every digit it has', () => {
    // About $10 of ETH, the size most testing uses.
    expect(formatTokenBalance(0.004, 'ETH')).toBe('0.004');
    expect(formatTokenBalance(0.0041234, 'ETH')).toBe('0.00412');
    expect(formatTokenBalance(0.00001, 'cBTC')).toBe('0.00001');
    expect(formatTokenBalance(0.00012, 'cBTC')).toBe('0.00012');
    expect(formatTokenBalance(1.23456, 'ETH')).toBe('1.23456');
  });

  test('a non-stablecoin keeps two decimals and drops zeros past them', () => {
    expect(formatTokenBalance(0.5, 'ETH')).toBe('0.50');
    expect(formatTokenBalance(1, 'ETH')).toBe('1.00');
    expect(formatTokenBalance(2, 'BNB')).toBe('2.00');
    expect(formatTokenBalance(0.207, 'ETH')).toBe('0.207');
    expect(formatTokenBalance(12.3456, 'ETH')).toBe('12.3456');
  });

  test('a stablecoin reads like money', () => {
    expect(formatTokenBalance(1250, 'USDC')).toBe('1250');
    expect(formatTokenBalance(1250.5, 'USDC')).toBe('1250.50');
    expect(formatTokenBalance(23.295, 'USDC')).toBe('23.30');
    expect(formatTokenBalance(0.01, 'USDC')).toBe('0.01');
    expect(formatTokenBalance(0.999, 'ppUSDC')).toBe('1');
  });

  test('a genuine zero still reads as zero', () => {
    expect(formatTokenBalance(0, 'cBTC')).toBe('0.00');
    expect(formatTokenBalance(0, 'USDC')).toBe('0');
  });

  test('a negative amount keeps its sign', () => {
    // A negative would mean an accounting bug upstream; it must stay visible.
    expect(formatTokenBalance(-0.5, 'ETH')).toBe('-0.50');
    expect(formatTokenBalance(-0.000004, 'cBTC')).toBe('-0.000004');
  });
});

describe('formatTokenBalanceDown', () => {
  test('never rounds a spendable figure up past what can be withdrawn', () => {
    // Artem 2026-10-19: 0.0044999 ETH read as "0.0045", typing it back failed.
    expect(formatTokenBalanceDown(0.0044999, 'ETH')).toBe('0.00449');
    expect(formatTokenBalance(0.0044999, 'ETH')).toBe('0.0045');
  });
  test('an exact figure survives float noise (0.0045 * 1e4 is 44.999...)', () => {
    expect(formatTokenBalanceDown(0.0045, 'ETH')).toBe('0.0045');
  });
  test('stablecoins and small amounts round down too', () => {
    expect(formatTokenBalanceDown(12.999, 'USDC')).toBe('12.99');
    expect(formatTokenBalanceDown(0.0000049, 'ETH')).toBe('0.0000049');
    expect(formatTokenBalanceDown(0.00000499, 'ETH')).toBe('0.0000049');
  });
  test('zero and whole stable amounts keep the usual shape', () => {
    expect(formatTokenBalanceDown(0, 'ETH')).toBe(formatTokenBalance(0, 'ETH'));
    expect(formatTokenBalanceDown(1250, 'USDC')).toBe('1250');
  });
});

describe('formatTokenBalanceDown on exact figures', () => {
  test('a value just under a step is not rounded across it', () => {
    expect(formatTokenBalanceDown(1.239999999999, 'ETH')).toBe('1.23999');
    expect(formatTokenBalanceDown('0.004499999999999999', 'ETH')).toBe('0.00449');
  });
  test('an exact formatUnits string keeps its digits', () => {
    expect(formatTokenBalanceDown('0.0045', 'ETH')).toBe('0.0045');
    expect(formatTokenBalanceDown('12.999999', 'USDC')).toBe('12.99');
  });
});

// Artem, 2026-10-30: on the Withdraw form and Review the USD figures had
// separators and the token figures did not ("$4,533.11" next to "4526.74 USDC").
describe('thousands separators are display only', () => {
  test('every figure in a label is grouped, decimals and symbol untouched', () => {
    expect(groupThousands('4526.74 USDC')).toBe('4,526.74 USDC');
    expect(groupThousands('4501.33 USDC')).toBe('4,501.33 USDC');
    expect(groupThousands('≈ 4500 USDC')).toBe('≈ 4,500 USDC');
    expect(groupThousands('100000 USDC')).toBe('100,000 USDC');
    expect(groupThousands('1234567.891 ETH')).toBe('1,234,567.891 ETH');
    expect(groupThousands('USDC Pool · 25.41 USDC left after')).toBe('USDC Pool · 25.41 USDC left after');
  });
  test('small figures, grouped figures and zero are left alone', () => {
    expect(groupThousands('999 USDC')).toBe('999 USDC');
    expect(groupThousands('0.0045 ETH')).toBe('0.0045 ETH');
    expect(groupThousands('4,526.74 USDC')).toBe('4,526.74 USDC');
    expect(groupThousands('0')).toBe('0');
    expect(groupThousands('—')).toBe('—');
  });
  test('the amount field is grouped only while it is not being typed in', () => {
    expect(amountInputDisplay('4526', false)).toBe('4,526');
    expect(amountInputDisplay('4526.5', false)).toBe('4,526.5');
    // A trailing point and trailing zeros survive: nothing the user typed is lost.
    expect(amountInputDisplay('4526.', false)).toBe('4,526.');
    expect(amountInputDisplay('4526.50', false)).toBe('4,526.50');
    // Focused: raw, so the caret and the keystrokes are never fought.
    expect(amountInputDisplay('4526', true)).toBe('4526');
    // Anything that is not a plain decimal is not touched.
    expect(amountInputDisplay('', false)).toBe('');
    expect(amountInputDisplay('1e5', false)).toBe('1e5');
  });
  test('a typed or pasted figure loses its separators and nothing else', () => {
    expect(stripAmountSeparators('4,526.50')).toBe('4526.50');
    expect(stripAmountSeparators('1,234,567')).toBe('1234567');
    expect(stripAmountSeparators('4526.')).toBe('4526.');
    // Grouping then stripping is the identity on a plain decimal: MAX text never drifts.
    for (const raw of ['4526.739999', '1000', '0.000001', '123456789.12', '7']) {
      expect(stripAmountSeparators(amountInputDisplay(raw, false))).toBe(raw);
    }
  });
});

// bun cannot render the components, so the wiring is pinned in source: the field
// shows grouped text while idle, raw while focused, and every keystroke or paste
// goes through the separator strip before it becomes an amount.
describe('amount field wiring', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
  for (const file of ['components/home/action-hub.tsx', 'components/withdraw-modal-provider.tsx']) {
    test(`${file}: grouped when idle, separators stripped on input`, () => {
      const source = read(file);
      expect(source).toContain('stripAmountSeparators(typed)');
      expect(source).toMatch(/value=\{amountInputDisplay\(/);
      expect(source).toMatch(/onFocus=\{\(\) => \{?[^}]*set(Amount|AmountInput)Focused\(true\)/);
      expect(source).toMatch(/onBlur=\{\(\) => \{?[^}]*set(Amount|AmountInput)Focused\(false\)/);
    });
  }
});
