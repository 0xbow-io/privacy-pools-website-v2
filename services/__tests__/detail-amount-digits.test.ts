import { describe, expect, test } from 'bun:test';
import { detailAmountDigits } from '../token-format';

describe('detailAmountDigits', () => {
  test('a high-value asset keeps two decimals', () => {
    expect(detailAmountDigits('0.500000', 'ETH')).toBe('0.50');
    expect(detailAmountDigits('1', 'ETH')).toBe('1.00');
    expect(detailAmountDigits('2.000000', 'BNB')).toBe('2.00');
    expect(detailAmountDigits('0.500000', 'ppETH')).toBe('0.50');
  });

  test('digits past the floor are never cut', () => {
    expect(detailAmountDigits('0.000600', 'ETH')).toBe('0.0006');
    expect(detailAmountDigits('32.476116', 'USDC')).toBe('32.476116');
    expect(detailAmountDigits('0.00001', 'cBTC')).toBe('0.00001');
  });

  test('a stablecoin reads like money', () => {
    expect(detailAmountDigits('1250.000000', 'USDC')).toBe('1250');
    expect(detailAmountDigits('1250.500000', 'USDC')).toBe('1250.50');
    expect(detailAmountDigits('1250.5', 'ppUSDC')).toBe('1250.50');
    expect(detailAmountDigits('0', 'USDT')).toBe('0');
  });

  test('a negative amount keeps its sign', () => {
    expect(detailAmountDigits('-0.5', 'ETH')).toBe('-0.50');
  });
});
