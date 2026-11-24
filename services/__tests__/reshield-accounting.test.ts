import { describe, expect, test } from 'bun:test';
import { displayedReshieldSurplus, estimatedReshieldSurplus } from '../reshield-accounting';

describe('reshield display accounting', () => {
  test('surplus includes output above the minimum and excludes the entire deposit budget', () => {
    // Different units from a yield note's 18-decimal share count.
    expect(estimatedReshieldSurplus(995_861_279n, 985_804_075n)).toBe(10_057_204n);
    expect(estimatedReshieldSurplus(90n, 100n)).toBe(0n);
  });

  test('deposit fees are not subtracted from surplus twice', () => {
    const note = 989_000_000n;
    const vetting = 989_000n;
    expect(estimatedReshieldSurplus(1_000_000_000n, note + vetting)).toBe(10_011_000n);
  });

  test('display boundaries reconcile to cents without changing transaction amounts', () => {
    const output = 995_861_279n;
    const deposit = 985_804_075n;
    const cent = 10_000n;
    const shown = displayedReshieldSurplus(output, deposit, cent);
    expect(shown).toBe(10_060_000n);
    expect(output / cent).toBe(deposit / cent + shown / cent);
    expect(estimatedReshieldSurplus(output, deposit)).toBe(10_057_204n);
  });

});
