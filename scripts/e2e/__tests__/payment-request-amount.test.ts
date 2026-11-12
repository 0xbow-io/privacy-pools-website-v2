import { expect, test } from 'bun:test';
import { parseEther } from 'viem';
import { paymentRequestAmount } from '../payment-request-amount';

const calculate = (price: number, vettingBps = 0n) => paymentRequestAmount({
  price, minimumUsd: 1.15,
  noteWei: parseEther('0.001') * (10_000n - vettingBps) / 10_000n,
  reserveWei: parseEther('0.0003'),
});

test('Nov 12 CI price fits without raising the cap or cutting the fee reserve', () => {
  expect(calculate(2052)).toBe('0.0007');
  expect(parseEther(calculate(2052)) + parseEther('0.0003')).toBe(parseEther('0.001'));
  expect(Number(calculate(2052)) * 2052).toBeGreaterThan(1.15 * 1.1);
});
test('keeps 25% headroom when the budget permits it', () => {
  expect(calculate(3000)).toBe('0.00048');
});
test('uses the note net of vetting and rounds down the available budget', () => {
  expect(calculate(2052, 100n)).toBe('0.00069');
});
test('refuses if even 10% headroom cannot fit, and rejects invalid prices', () => {
  expect(() => calculate(1600)).toThrow('refusing to spend');
  for (const price of [0, -1, NaN, Infinity]) expect(() => calculate(price)).toThrow('invalid USD price');
});
