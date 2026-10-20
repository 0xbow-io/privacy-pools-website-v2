import { describe, expect, test } from 'bun:test';

import { formatTokenBalance, formatTokenBalanceDown } from '@/services/token-format';

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
