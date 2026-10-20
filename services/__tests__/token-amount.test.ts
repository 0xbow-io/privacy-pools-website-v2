import { describe, expect, test } from 'bun:test';

import { fitAmountFontSize, parseTokenAmount } from '@/services/token-amount';

describe('fitAmountFontSize', () => {
  test('keeps the full size for short amounts and unmeasured fields', () => {
    expect(fitAmountFontSize('1.9447', 240, 44)).toBe(44);
    expect(fitAmountFontSize('1.944695638607677173', 0, 44)).toBe(44);
    expect(fitAmountFontSize('', 240, 44)).toBe(44);
  });

  test('shrinks a long exact amount until it fits', () => {
    const size = fitAmountFontSize('1.944695638607677173', 240, 44);
    expect(size).toBeLessThan(44);
    expect(size * 0.6 * 20).toBeLessThanOrEqual(240);
  });

  test('shrinks below the old floors on narrow fields instead of clipping', () => {
    const hubAmount = '1234.567890123456789012';
    const hubSize = fitAmountFontSize(hubAmount, 170, 44);
    expect(hubSize).toBeLessThan(20);
    expect(hubSize * 0.6 * hubAmount.length).toBeLessThanOrEqual(170);
    const sheetMax = '1.944695638607677173';
    const sheetSize = fitAmountFontSize(sheetMax, 130, 24);
    expect(sheetSize).toBeLessThan(16);
    expect(sheetSize * 0.6 * sheetMax.length).toBeLessThanOrEqual(130);
  });

  test('never collapses to a zero font size', () => {
    expect(fitAmountFontSize('1.944695638607677173', 5, 44)).toBe(1);
  });
});

describe('parseTokenAmount', () => {
  test('parses decimal token amounts exactly', () => {
    expect(parseTokenAmount('0.29', 6)).toBe(290000n);
    expect(parseTokenAmount('0.29', 2)).toBe(29n);
    expect(parseTokenAmount('1', 18)).toBe(1000000000000000000n);
    expect(parseTokenAmount('0.000001', 6)).toBe(1n);
    expect(parseTokenAmount('007.5', 2)).toBe(750n);
  });

  test('truncates excess fractional digits', () => {
    expect(parseTokenAmount('0.123456789', 6)).toBe(123456n);
  });

  test('returns zero for empty or invalid input', () => {
    expect(parseTokenAmount('', 18)).toBe(0n);
    expect(parseTokenAmount('.', 18)).toBe(0n);
    expect(parseTokenAmount('abc', 18)).toBe(0n);
    expect(parseTokenAmount('1e3', 18)).toBe(0n);
  });

  test('documents the float bug this helper avoids', () => {
    expect(BigInt(Math.floor(0.29 * 10 ** 2))).toBe(28n);
    expect(parseTokenAmount('0.29', 2)).toBe(29n);
  });
});
