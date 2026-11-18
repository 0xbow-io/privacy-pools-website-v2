import { expect, test } from 'bun:test';
import { parseEther } from 'viem';
import { paymentRequestAmount } from '../payment-request-amount';

const calculate = (price: number, vettingBps = 0n) => paymentRequestAmount({
  price, minimumUsd: 1.15,
  noteWei: parseEther('0.001') * (10_000n - vettingBps) / 10_000n,
  reserveWei: parseEther('0.0003'),
});

test('Nov 12 CI price fits without raising the cap or cutting the fee reserve', () => {
  for (const price of [2012.28, 2017.22, 2018.79, 2052]) {
    expect(calculate(price)).toBe('0.0007');
    expect(Number(calculate(price)) * price).toBeGreaterThan(1.15 * 1.1);
  }
  expect(parseEther(calculate(2052)) + parseEther('0.0003')).toBe(parseEther('0.001'));
  expect(Number(calculate(2052)) * 2052).toBeGreaterThan(1.15 * 1.1);
});
// 2026-11-18: ETH fell to about $1748 and the 0.0003 reserve left a budget of
// 0.0007 ETH, which covers the $1.15 floor with headroom only above ~$1807, so
// the payment group refused to seed. The reserve is 0.0002 now (funding.ts).
const withReserve = (price: number, reserve: string) => paymentRequestAmount({
  price, minimumUsd: 1.15, noteWei: parseEther('0.001'), reserveWei: parseEther(reserve),
});
test('the 0.0002 reserve fits ETH at 1748 and still refuses well below that', () => {
  expect(() => withReserve(1748.4, '0.0003')).toThrow('refusing to spend');
  expect(withReserve(1748.4, '0.0002')).toBe('0.0008');
  expect(Number(withReserve(1748.4, '0.0002')) * 1748.4).toBeGreaterThan(1.15 * 1.1);
  expect(() => withReserve(1550, '0.0002')).toThrow('refusing to spend');
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
