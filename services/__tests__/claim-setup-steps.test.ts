import { describe, expect, test } from 'bun:test';

import { claimSetupLegMessage, claimSetupPlan, claimSetupSteps } from '@/services/claim-setup-steps';

describe('claim page names the one-time setup', () => {
  test('a wallet the relayer registers sends no transaction, so no setup step', () => {
    expect(claimSetupPlan({ setupState: 'unregistered', walletPaysGas: false })).toEqual({ kind: 'none' });
    expect(claimSetupSteps({ kind: 'none' })).toBeNull();
  });

  test('a registered wallet has no setup step', () => {
    expect(claimSetupPlan({ setupState: 'complete', walletPaysGas: true })).toEqual({ kind: 'none' });
  });

  test('an unregistered wallet that pays gas confirms twice, a partial one once', () => {
    expect(claimSetupPlan({ setupState: 'unregistered', walletPaysGas: true })).toEqual({ kind: 'setup', confirmations: 2 });
    expect(claimSetupPlan({ setupState: 'partial', walletPaysGas: true })).toEqual({ kind: 'setup', confirmations: 1 });
    expect(claimSetupSteps({ kind: 'setup', confirmations: 2 })?.setup).toContain('2 wallet confirmations');
    expect(claimSetupSteps({ kind: 'setup', confirmations: 1 })?.setup).toContain('1 wallet confirmation,');
  });

  test('an unread setup state still warns, hedged', () => {
    expect(claimSetupPlan({ setupState: 'unknown', walletPaysGas: true })).toEqual({ kind: 'maybe' });
    expect(claimSetupSteps({ kind: 'maybe' })?.setup).toContain('up to 2 wallet confirmations');
  });

  test('the claim step says it is relayed, with no wallet transaction', () => {
    expect(claimSetupSteps({ kind: 'setup', confirmations: 2 })?.claim).toContain('no wallet transaction');
  });

  test('each setup prompt says it is the setup, not the claim', () => {
    expect(claimSetupLegMessage(1, 2, 'confirm')).toBe('One-time setup 1 of 2: confirm in your wallet. This is not the claim yet.');
    expect(claimSetupLegMessage(2, 2, 'confirming')).toBe('One-time setup 2 of 2: waiting for the network.');
    expect(claimSetupLegMessage(1, 1, 'confirm').startsWith('One-time setup: confirm')).toBe(true);
  });

  test('copy has no em dashes and no share symbols', () => {
    const all = [
      ...Object.values(claimSetupSteps({ kind: 'setup', confirmations: 2 })!),
      ...Object.values(claimSetupSteps({ kind: 'maybe' })!),
      claimSetupLegMessage(1, 2, 'confirm'),
      claimSetupLegMessage(1, 2, 'confirming'),
    ].join(' ');
    expect(all).not.toContain('—');
    expect(all).not.toMatch(/\bpp(ETH|USDC|USDT)\b/);
  });
});
