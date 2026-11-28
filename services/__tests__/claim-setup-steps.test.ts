import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { claimProgressSurface, claimSetupLegMessage, claimSetupPlan, claimSetupSteps, type ClaimFundingView } from '@/services/claim-setup-steps';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const GWEI = 1_000_000_000n;
const ETH = 10n ** 18n;
const estimate = (balanceWei: bigint | undefined, gasPriceWei: bigint | null | undefined, relayCanRegister = true): ClaimFundingView =>
  ({ source: 'estimate', balanceWei, gasPriceWei, relayCanRegister });

describe('claim page names the one-time setup', () => {
  test('probed self-funded: steps shown, two confirmations unregistered, one partial', () => {
    expect(claimSetupPlan({ setupState: 'unregistered', funding: { source: 'probed', kind: 'self-funded' } })).toEqual({ kind: 'setup', confirmations: 2 });
    expect(claimSetupPlan({ setupState: 'partial', funding: { source: 'probed', kind: 'self-funded' } })).toEqual({ kind: 'setup', confirmations: 1 });
    expect(claimSetupSteps({ kind: 'setup', confirmations: 2 })?.setup).toContain('up to 2 wallet confirmations');
    expect(claimSetupSteps({ kind: 'setup', confirmations: 1 })?.setup).toContain('1 wallet confirmation,');
  });

  test('probed unfunded is still attempted with wallet transactions, so it warns', () => {
    expect(claimSetupPlan({ setupState: 'unregistered', funding: { source: 'probed', kind: 'unfunded' } })).toEqual({ kind: 'setup', confirmations: 2 });
  });

  test('probed relayer-funded, or setup already done: no setup step', () => {
    expect(claimSetupPlan({ setupState: 'unregistered', funding: { source: 'probed', kind: 'relayed' } })).toEqual({ kind: 'none' });
    expect(claimSetupPlan({ setupState: 'complete', funding: { source: 'probed', kind: 'self-funded' } })).toEqual({ kind: 'none' });
    expect(claimSetupPlan({ setupState: 'complete', funding: estimate(undefined, null) })).toEqual({ kind: 'none' });
    expect(claimSetupSteps({ kind: 'none' })).toBeNull();
  });

  test('balance not loaded: hedged, never none', () => {
    expect(claimSetupPlan({ setupState: 'unregistered', funding: estimate(undefined, 10n * GWEI) })).toEqual({ kind: 'maybe' });
    expect(claimSetupPlan({ setupState: 'unknown', funding: estimate(undefined, null) })).toEqual({ kind: 'maybe' });
  });

  test('unknown gas price with a nonzero balance: the claim keeps the wallet paying, so not none', () => {
    // decideRegistrationPath: 'unknown-gas-price' stays on the self-funded path.
    expect(claimSetupPlan({ setupState: 'unknown', funding: estimate(ETH, null) })).toEqual({ kind: 'maybe' });
    expect(claimSetupPlan({ setupState: 'unknown', funding: estimate(ETH, undefined) })).toEqual({ kind: 'maybe' });
    expect(claimSetupPlan({ setupState: 'unregistered', funding: estimate(ETH, null) })).toEqual({ kind: 'setup', confirmations: 2 });
  });

  test('estimate: a funded wallet pays its setup, an empty one on a carrying relay does not', () => {
    expect(claimSetupPlan({ setupState: 'unregistered', funding: estimate(ETH, 10n * GWEI) })).toEqual({ kind: 'setup', confirmations: 2 });
    expect(claimSetupPlan({ setupState: 'unregistered', funding: estimate(0n, 10n * GWEI) })).toEqual({ kind: 'none' });
    expect(claimSetupPlan({ setupState: 'unregistered', funding: estimate(1n, 10n * GWEI) })).toEqual({ kind: 'none' });
  });

  test('estimate: a relay that cannot register the wallet leaves the setup on the wallet', () => {
    expect(claimSetupPlan({ setupState: 'unregistered', funding: estimate(0n, 10n * GWEI, false) })).toEqual({ kind: 'setup', confirmations: 2 });
  });

  test('an unread setup state still warns, hedged', () => {
    expect(claimSetupPlan({ setupState: 'unknown', funding: estimate(ETH, 10n * GWEI) })).toEqual({ kind: 'maybe' });
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

describe('the setup comes before the claim progress (review, 0xmatthewb)', () => {
  test('setup shows its own line, the staged progress only once the claim itself runs', () => {
    expect(claimProgressSurface({ anchoring: true, claimPhase: 'setup' })).toBe('setup-line');
    expect(claimProgressSurface({ anchoring: true, claimPhase: 'claim' })).toBe('progress');
    expect(claimProgressSurface({ anchoring: false, claimPhase: 'setup' })).toBe('none');
  });

  test('the claim enters setup before the registration, and leaves it before proving', () => {
    const src = read('hooks/use-note-import.ts');
    const claimStart = src.indexOf('const importOnChain = useCallback(');
    const enter = src.indexOf("setClaimPhase('setup')", claimStart);
    const register = src.indexOf('await sendRegistrationLegs(registration', claimStart);
    const leave = src.indexOf("setClaimPhase('claim')", register);
    const prove = src.indexOf('setStatusMessage(healedNotes.length > 1 ? `Generating proof', claimStart);
    expect(claimStart).toBeGreaterThan(-1);
    expect(enter).toBeGreaterThan(claimStart);
    expect(register).toBeGreaterThan(enter);
    expect(leave).toBeGreaterThan(register);
    expect(prove).toBeGreaterThan(leave);
  });

  test('both claim surfaces gate the progress on claimProgressSurface', () => {
    for (const rel of ['app/import-note/[encoded].tsx', 'components/import-note-modal-provider.tsx']) {
      const src = read(rel);
      expect(src).toContain("claimProgressSurface({ anchoring: status === 'anchoring', claimPhase }) === 'progress' ? (");
      expect(src).not.toMatch(/\{status === 'anchoring' \? \(\s*<FlowProgress/);
    }
  });
});
