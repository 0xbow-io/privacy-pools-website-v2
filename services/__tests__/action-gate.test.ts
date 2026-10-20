import { describe, expect, test } from 'bun:test';
import { fundedActionsDisabled, hasPositiveDecimal } from '../action-gate';

const ready = { connected: true, balancesLoading: false };

describe('fundedActionsDisabled', () => {
  test('disconnected users are never gated (they route through connect)', () => {
    expect(fundedActionsDisabled({ connected: false, balancesLoading: false, activeBalancesExact: ['0'] })).toBe(false);
  });

  test('loading balances are unknown, not confirmed zero', () => {
    expect(fundedActionsDisabled({ connected: true, balancesLoading: true, activeBalancesExact: [] })).toBe(false);
    expect(fundedActionsDisabled({ connected: true, balancesLoading: true, activeBalancesExact: ['0'] })).toBe(false);
  });

  test('pending-only balances disable. Pending funds are not spendable', () => {
    // Callers pass ACTIVE balances only; a pending-only account passes zeros.
    expect(fundedActionsDisabled({ ...ready, activeBalancesExact: ['0', '0.0'] })).toBe(true);
  });

  test('EVM dust below the 4-decimal display rounding still counts as funds', () => {
    // 1 wei of an 18-decimal token — displays as "0.0000" but is spendable.
    expect(fundedActionsDisabled({ ...ready, activeBalancesExact: ['0.000000000000000001'] })).toBe(false);
  });

  test('Sui dust (9-decimal MIST) still counts as funds', () => {
    expect(fundedActionsDisabled({ ...ready, activeBalancesExact: ['0.000000001'] })).toBe(false);
  });

  test('a normal EVM balance keeps actions enabled', () => {
    expect(fundedActionsDisabled({ ...ready, activeBalancesExact: ['0', '1.5'] })).toBe(false);
  });

  test('confirmed zero across all pools disables', () => {
    expect(fundedActionsDisabled({ ...ready, activeBalancesExact: ['0', '0.0000', '0.000000000'] })).toBe(true);
    expect(fundedActionsDisabled({ ...ready, activeBalancesExact: [] })).toBe(true);
  });

  test('unparseable balances fail open', () => {
    expect(fundedActionsDisabled({ ...ready, activeBalancesExact: ['garbage'] })).toBe(false);
    expect(fundedActionsDisabled({ ...ready, activeBalancesExact: [undefined] })).toBe(false);
    expect(fundedActionsDisabled({ ...ready, activeBalancesExact: ['0.0000 ETH'] })).toBe(false);
  });
});

describe('hasPositiveDecimal', () => {
  test('detects positives, zeros, and garbage', () => {
    expect(hasPositiveDecimal('0.000000000000000001')).toBe(true);
    expect(hasPositiveDecimal('12.5')).toBe(true);
    expect(hasPositiveDecimal('0')).toBe(false);
    expect(hasPositiveDecimal('0.0000')).toBe(false);
    expect(hasPositiveDecimal('')).toBe(false);
    expect(hasPositiveDecimal(null)).toBe(false);
    expect(hasPositiveDecimal('1,5')).toBe(false);
  });
});
