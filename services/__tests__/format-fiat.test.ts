import { describe, expect, test } from 'bun:test';
import { formatUsd, formatUsdPrecise } from '@/services/format-fiat';

describe('formatUsd (compact)', () => {
  test('renders zero as $0', () => {
    expect(formatUsd(0)).toBe('$0');
  });

  test('guards sub-cent positive amounts', () => {
    expect(formatUsd(0.004)).toBe('<$0.01');
  });

  test('shows cents under a dollar so testnet dust stays visible', () => {
    expect(formatUsd(0.42)).toBe('$0.42');
    expect(formatUsd(0.005)).toBe('$0.01');
  });

  test('renders integers with separators under the $10k cutover', () => {
    expect(formatUsd(4674.1)).toBe('$4,674');
    expect(formatUsd(9999)).toBe('$9,999');
  });

  test('abbreviates to k/M/B above the cutover, trailing zeros stripped', () => {
    expect(formatUsd(10_000)).toBe('$10k');
    expect(formatUsd(10_820)).toBe('$10.82k');
    expect(formatUsd(1_500_000)).toBe('$1.5M');
    expect(formatUsd(2_000_000_000)).toBe('$2B');
  });
});

describe('formatUsdPrecise', () => {
  test('always shows two decimals', () => {
    expect(formatUsdPrecise(5)).toBe('$5.00');
    expect(formatUsdPrecise(0)).toBe('$0.00');
  });

  test('adds thousands separators (the improvement over $${x.toFixed(2)})', () => {
    expect(formatUsdPrecise(1234.56)).toBe('$1,234.56');
    expect(formatUsdPrecise(1234567.891)).toBe('$1,234,567.89');
  });

  test('rounds to cents', () => {
    expect(formatUsdPrecise(0.005)).toBe('$0.01');
    expect(formatUsdPrecise(10.999)).toBe('$11.00');
  });
});
