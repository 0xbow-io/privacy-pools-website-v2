import { describe, expect, test } from 'bun:test';
import {
  decideConnectLandingInvariant,
  hasAnyBalance,
  hasPublicDepositActivity,
  shouldOpenBalancesOnConnect,
  shouldOpenSeedOnConnectLanding,
  type ConnectLandingInvariantInput,
  type ConnectLandingInput,
} from '../connect-landing';

describe('hasAnyBalance', () => {
  test('true for a settled balance', () => {
    expect(hasAnyBalance([{ balanceTokenExact: '0.07', pendingTokenExact: '0' }])).toBe(true);
  });

  test('true for a PENDING-only balance', () => {
    expect(hasAnyBalance([{ balanceTokenExact: '0', pendingTokenExact: '1.5' }])).toBe(true);
  });

  test('false when everything is zero', () => {
    expect(hasAnyBalance([{ balanceTokenExact: '0', pendingTokenExact: '0' }])).toBe(false);
    expect(hasAnyBalance([{ balanceTokenExact: '0.000', pendingTokenExact: '0.0' }])).toBe(false);
  });

  test('true for dust that the DISPLAY value would round to zero', () => {
    // The whole reason this reads the exact fields.
    expect(hasAnyBalance([{ balanceTokenExact: '0.00001' }])).toBe(true);
  });

  test('false for empty / missing / malformed input', () => {
    expect(hasAnyBalance([])).toBe(false);
    expect(hasAnyBalance(null)).toBe(false);
    expect(hasAnyBalance(undefined)).toBe(false);
    expect(hasAnyBalance([{}])).toBe(false);
    expect(hasAnyBalance([{ balanceTokenExact: '' }])).toBe(false);
    expect(hasAnyBalance([{ balanceTokenExact: 'not-a-number' }])).toBe(false);
    expect(hasAnyBalance([{ balanceTokenExact: 'NaN' }])).toBe(false);
    expect(hasAnyBalance([{ balanceTokenExact: 'Infinity' }])).toBe(false);
  });

  test('a negative amount is not a balance', () => {
    expect(hasAnyBalance([{ balanceTokenExact: '-1' }])).toBe(false);
  });

  test('any one funded pool among many is enough', () => {
    expect(hasAnyBalance([
      { balanceTokenExact: '0', pendingTokenExact: '0' },
      { balanceTokenExact: '0', pendingTokenExact: '0' },
      { balanceTokenExact: '2', pendingTokenExact: '0' },
    ])).toBe(true);
  });
});

const READY: ConnectLandingInput = {
  isNewDesign: true,
  settled: true,
  armed: true,
  balancesLoading: false,
  hasBalance: true,
  userNavigated: false,
  panelAlreadyOpen: false,
};

describe('shouldOpenBalancesOnConnect', () => {
  test('redirects on a fresh connect with a balance', () => {
    expect(shouldOpenBalancesOnConnect(READY)).toBe(true);
  });

  test('never in Classic. It has no panel to land on', () => {
    expect(shouldOpenBalancesOnConnect({ ...READY, isNewDesign: false })).toBe(false);
  });

  test('not before the wallet state settles (guards session restore)', () => {
    expect(shouldOpenBalancesOnConnect({ ...READY, settled: false })).toBe(false);
  });

  test('not unless armed by an actual connect transition', () => {
    expect(shouldOpenBalancesOnConnect({ ...READY, armed: false })).toBe(false);
  });

  test('a still-loading balance is not an empty one. Waits', () => {
    expect(shouldOpenBalancesOnConnect({ ...READY, balancesLoading: true })).toBe(false);
  });

  test('no balance, no redirect', () => {
    expect(shouldOpenBalancesOnConnect({ ...READY, hasBalance: false })).toBe(false);
  });

  test('the user having navigated wins. This is what stops it trapping them', () => {
    expect(shouldOpenBalancesOnConnect({ ...READY, userNavigated: true })).toBe(false);
  });

  test('does nothing when a panel is already open', () => {
    expect(shouldOpenBalancesOnConnect({ ...READY, panelAlreadyOpen: true })).toBe(false);
  });

  test('every single guard is independently sufficient to block', () => {
    const blockers: Partial<ConnectLandingInput>[] = [
      { isNewDesign: false },
      { settled: false },
      { armed: false },
      { balancesLoading: true },
      { hasBalance: false },
      { userNavigated: true },
      { panelAlreadyOpen: true },
    ];
    for (const b of blockers) {
      expect(shouldOpenBalancesOnConnect({ ...READY, ...b })).toBe(false);
    }
  });
});

describe('hasPublicDepositActivity. The keystore-free signal', () => {
  const ADDR = '0xD3581763f41FC0763a49E9ab53F2D3D425870a3D';
  const rows = [
    { fullAddress: ADDR, type: 'Deposit', tokenAmount: 0.05 },
    { fullAddress: '0xother', type: 'Deposit', tokenAmount: 9 },
  ];

  test('matches the connected address case-insensitively', () => {
    expect(hasPublicDepositActivity(rows, ADDR)).toBe(true);
    expect(hasPublicDepositActivity(rows, ADDR.toLowerCase())).toBe(true);
    expect(hasPublicDepositActivity(rows, ADDR.toUpperCase())).toBe(true);
  });

  test('does not match a different address', () => {
    expect(hasPublicDepositActivity(rows, '0xnobody')).toBe(false);
  });

  test('only deposits count. A withdrawal is not evidence of a holding', () => {
    expect(hasPublicDepositActivity(
      [{ fullAddress: ADDR, type: 'Withdrawal', tokenAmount: 1 }], ADDR)).toBe(false);
    expect(hasPublicDepositActivity(
      [{ fullAddress: ADDR, type: 'Transfer', tokenAmount: 1 }], ADDR)).toBe(false);
  });

  test('a zero-amount deposit is not a balance', () => {
    expect(hasPublicDepositActivity(
      [{ fullAddress: ADDR, type: 'Deposit', tokenAmount: 0 }], ADDR)).toBe(false);
  });

  test('empty / missing input never throws or matches', () => {
    expect(hasPublicDepositActivity([], ADDR)).toBe(false);
    expect(hasPublicDepositActivity(null, ADDR)).toBe(false);
    expect(hasPublicDepositActivity(rows, null)).toBe(false);
    expect(hasPublicDepositActivity(rows, undefined)).toBe(false);
    expect(hasPublicDepositActivity([{}], ADDR)).toBe(false);
  });

  test('this is what makes a wallet-only connect work: no notes needed', () => {
    // hasAnyBalance sees nothing (no keystore session -> no notes) yet the
    // public feed still identifies the depositor.
    expect(hasAnyBalance([])).toBe(false);
    expect(hasPublicDepositActivity(rows, ADDR)).toBe(true);
  });
});

const ARMED_INVARIANT: ConnectLandingInvariantInput = {
  isNewDesign: true,
  phase: 'armed',
  routerReady: true,
  funded: true,
  pathname: '/',
  dismissed: false,
  panel: null,
};

describe('decideConnectLandingInvariant', () => {
  test('waits for arbitrarily late funding, then opens without a timer event', () => {
    const unfunded = { ...ARMED_INVARIANT, funded: false };
    expect(decideConnectLandingInvariant(unfunded)).toBe('wait');
    expect(decideConnectLandingInvariant(unfunded)).toBe('wait');
    expect(decideConnectLandingInvariant({ ...unfunded, funded: true })).toBe('open');
  });

  test('waits for router readiness, then opens without a settle timeout', () => {
    const hydrating = { ...ARMED_INVARIANT, routerReady: false };
    expect(decideConnectLandingInvariant(hydrating)).toBe('wait');
    expect(decideConnectLandingInvariant({ ...hydrating, routerReady: true })).toBe('open');
  });

  test('an identity restored directly into armed can open immediately', () => {
    // No disconnected -> connected transition or elapsed-time event is needed.
    expect(decideConnectLandingInvariant(ARMED_INVARIANT)).toBe('open');
  });

  test('an externally stripped panel remains repairable indefinitely', () => {
    const enforcing = { ...ARMED_INVARIANT, phase: 'enforcing' as const };
    expect(decideConnectLandingInvariant({ ...enforcing, panel: 'balances' })).toBe('satisfied');

    // Re-observing stable state any number of times does not spend a retry or
    // expire a grace period; a later strip is still repaired.
    for (let i = 0; i < 20; i += 1) {
      expect(decideConnectLandingInvariant({ ...enforcing, panel: 'balances' })).toBe('satisfied');
    }
    expect(decideConnectLandingInvariant({ ...enforcing, panel: null })).toBe('repair');
    expect(decideConnectLandingInvariant({ ...enforcing, panel: 'pools' })).toBe('repair');
  });

  test('managed dismissal and stopped phase are terminal', () => {
    expect(decideConnectLandingInvariant({ ...ARMED_INVARIANT, dismissed: true })).toBe('stop');
    expect(decideConnectLandingInvariant({
      ...ARMED_INVARIANT,
      phase: 'stopped',
      panel: 'balances',
    })).toBe('stop');
  });

  test('navigation away from home is terminal once the router is ready', () => {
    expect(decideConnectLandingInvariant({ ...ARMED_INVARIANT, pathname: '/explore' })).toBe('stop');
    // Before hydration resolves the pathname is not yet authoritative.
    expect(decideConnectLandingInvariant({
      ...ARMED_INVARIANT,
      routerReady: false,
      pathname: '/explore',
    })).toBe('wait');
  });

  test('a pre-arm off-home pathname is boot noise, not a terminal choice', () => {
    // Field regression: a transient hydration pathname stopped the machine
    // while still `waiting` (no wallet report yet), so the funded connect a
    // moment later found it terminally dead and never redirected.
    expect(decideConnectLandingInvariant({
      ...ARMED_INVARIANT,
      phase: 'waiting',
      pathname: '/explore',
    })).toBe('wait');
    // Once armed, the same pathname IS a user choice and stays terminal.
    expect(decideConnectLandingInvariant({ ...ARMED_INVARIANT, pathname: '/explore' })).toBe('stop');
    expect(decideConnectLandingInvariant({
      ...ARMED_INVARIANT,
      phase: 'enforcing',
      pathname: '/explore',
    })).toBe('stop');
  });

  test('an already-present balances panel is idempotently satisfied', () => {
    expect(decideConnectLandingInvariant({ ...ARMED_INVARIANT, panel: 'balances' })).toBe('satisfied');
    expect(decideConnectLandingInvariant({
      ...ARMED_INVARIANT,
      phase: 'enforcing',
      panel: 'balances',
    })).toBe('satisfied');
  });

  test('waiting and Classic never open or repair', () => {
    expect(decideConnectLandingInvariant({ ...ARMED_INVARIANT, phase: 'waiting' })).toBe('wait');
    expect(decideConnectLandingInvariant({ ...ARMED_INVARIANT, isNewDesign: false })).toBe('wait');
  });
});

describe('shouldOpenSeedOnConnectLanding', () => {
  const LOCKED_EMPTY = {
    firstLanding: true,
    sessionLocked: true,
    hasCachedBalance: false,
    seedHandled: false,
  };

  test('opens once on the first locked landing with no cached balance', () => {
    expect(shouldOpenSeedOnConnectLanding(LOCKED_EMPTY)).toBe(true);
    expect(shouldOpenSeedOnConnectLanding({ ...LOCKED_EMPTY, seedHandled: true })).toBe(false);
  });

  test('never opens for a cached balance, ready session, or URL repair', () => {
    expect(shouldOpenSeedOnConnectLanding({ ...LOCKED_EMPTY, hasCachedBalance: true })).toBe(false);
    expect(shouldOpenSeedOnConnectLanding({ ...LOCKED_EMPTY, sessionLocked: false })).toBe(false);
    expect(shouldOpenSeedOnConnectLanding({ ...LOCKED_EMPTY, firstLanding: false })).toBe(false);
  });
});
