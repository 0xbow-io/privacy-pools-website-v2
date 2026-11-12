import { describe, expect, test } from 'bun:test';
import { estimatedUsdLabel } from '../estimated-usd';

describe('estimated USD presentation', () => {
  test('unknown, nonfinite and empty estimates stay unavailable', () => {
    for (const value of [0, -1, NaN, Infinity, -Infinity]) expect(estimatedUsdLabel(value)).toBeNull();
  });
  test('small positive outputs never appear to be worth zero', () => {
    expect(estimatedUsdLabel(0.001)).toBe('≈ <$0.01');
  });
  test('a quote is clearly estimated and rounded only for display', () => {
    expect(estimatedUsdLabel(1234.567)).toBe('≈ $1,234.57');
    expect(estimatedUsdLabel(1)).toBe('≈ $1.00');
  });
});
