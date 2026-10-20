import { describe, expect, test } from 'bun:test';
import {
  computeDepositTotal,
  FULL_WITHDRAWAL_ESCAPE_TAB,
  guardBlocksCta,
  guardNext,
  INITIAL_GUARD_STATE,
  isFullWithdrawalSelectionWei,
  percentOfWei,
  type FullWithdrawalGuardState,
} from '../yield-math';

describe('computeDepositTotal (A1/A2 re-total)', () => {
  test('yield ON: total is exactly the entered amount', () => {
    expect(computeDepositTotal(100, true, 0.003)).toBe(100);
  });

  test('yield OFF: total adds the (enforced) opt-out fee', () => {
    expect(computeDepositTotal(100, false, 0.003)).toBeCloseTo(100.003, 10);
  });

  test('a 0 fee (unenforced/undecided) keeps both states identical', () => {
    expect(computeDepositTotal(100, false, 0)).toBe(computeDepositTotal(100, true, 0));
  });

  test('zero / invalid amount totals 0', () => {
    expect(computeDepositTotal(0, false, 0.003)).toBe(0);
    expect(computeDepositTotal(NaN, true, 0.003)).toBe(0);
  });
});

describe('percentOfWei (integer-unit tabs, codex finding 6)', () => {
  test('exact integer division, no float rounding', () => {
    expect(percentOfWei(200n, 100)).toBe(200n);
    expect(percentOfWei(200n, 75)).toBe(150n);
    expect(percentOfWei(200n, 50)).toBe(100n);
    // 25% of an odd base floors, never rounds up over the cap
    expect(percentOfWei(3n, 25)).toBe(0n);
  });
  test('zero-states', () => {
    expect(percentOfWei(0n, 100)).toBe(0n);
    expect(percentOfWei(100n, 0)).toBe(0n);
  });
});

describe('isFullWithdrawalSelectionWei (exact, fee-aware, codex finding 6)', () => {
  test('gross == cap trips', () => {
    expect(isFullWithdrawalSelectionWei({ grossLeavingWei: 200n, totalBalanceWei: 200n })).toBe(true);
  });
  test('gross > cap trips (receive-exact fee pushes it over)', () => {
    expect(isFullWithdrawalSelectionWei({ grossLeavingWei: 205n, totalBalanceWei: 200n })).toBe(true);
  });
  test('gross < cap does not trip', () => {
    expect(isFullWithdrawalSelectionWei({ grossLeavingWei: 150n, totalBalanceWei: 200n })).toBe(false);
  });
  test('the 0.0002-balance / 75%-escape retrip bug is gone (150 < 200)', () => {
    // 75% of 200 base units = 150; must NOT be classified as full
    const escapeWei = percentOfWei(200n, 75);
    expect(isFullWithdrawalSelectionWei({ grossLeavingWei: escapeWei, totalBalanceWei: 200n })).toBe(false);
  });
  test('zero balance / zero amount never trips', () => {
    expect(isFullWithdrawalSelectionWei({ grossLeavingWei: 200n, totalBalanceWei: 0n })).toBe(false);
    expect(isFullWithdrawalSelectionWei({ grossLeavingWei: 0n, totalBalanceWei: 200n })).toBe(false);
  });
});

describe('FullWithdrawalGuard reducer (production-consumed, codex findings 7 & 10)', () => {
  const idle = INITIAL_GUARD_STATE;

  test('full selection trips the guard, un-acknowledged', () => {
    const s = guardNext(idle, { type: 'selection', full: true });
    expect(s).toEqual({ tripped: true, acknowledged: false });
    expect(guardBlocksCta(s)).toBe(true);
  });

  test('ack while tripped unblocks the CTA', () => {
    let s = guardNext(idle, { type: 'selection', full: true });
    s = guardNext(s, { type: 'ack', value: true });
    expect(s).toEqual({ tripped: true, acknowledged: true });
    expect(guardBlocksCta(s)).toBe(false);
  });

  test('ack is ignored while not tripped', () => {
    expect(guardNext(idle, { type: 'ack', value: true })).toEqual(idle);
  });

  test('EVERY new selection clears acknowledgment. Including a repeated full selection (finding 7)', () => {
    let s = guardNext(idle, { type: 'selection', full: true });
    s = guardNext(s, { type: 'ack', value: true });
    expect(s.acknowledged).toBe(true);
    // Re-selecting (e.g. tapping 100% again) must require fresh consent
    s = guardNext(s, { type: 'selection', full: true });
    expect(s).toEqual({ tripped: true, acknowledged: false });
    expect(guardBlocksCta(s)).toBe(true);
  });

  test('dropping below full clears trip + ack', () => {
    let s: FullWithdrawalGuardState = { tripped: true, acknowledged: true };
    s = guardNext(s, { type: 'selection', full: false });
    expect(s).toEqual(idle);
  });

  test('escape / reset clear the guard; escape targets the 75% tab', () => {
    let s = guardNext(idle, { type: 'selection', full: true });
    s = guardNext(s, { type: 'ack', value: true });
    expect(guardNext(s, { type: 'escape' })).toEqual(idle);
    expect(guardNext(s, { type: 'reset' })).toEqual(idle);
    expect(FULL_WITHDRAWAL_ESCAPE_TAB).toBe('75%');
  });
});

// Integration: replays the exact controller the withdraw modal runs — every
// selection recomputes `full` via isFullWithdrawalSelectionWei and dispatches a
// guardNext 'selection' event (clearing ack); tabs use percentOfWei. This pins
// the production decision path, not orphaned helpers (codex finding 10). The
// node test harness has no RN renderer, so this composes the real functions the
// provider calls rather than mounting it.
describe('withdrawal guard controller (integrated production sequence)', () => {
  const availableWei = 200n; // per-withdrawal cap in base units
  const feeWei = 0n; // pre-quote

  // Mirror of the component: full = exact fee-aware base-unit predicate.
  const fullFor = (enteredWei: bigint, guardActive: boolean) =>
    guardActive && isFullWithdrawalSelectionWei({ grossLeavingWei: enteredWei + feeWei, totalBalanceWei: availableWei });

  test('type 75% → not tripped; tab 100% → tripped; ack; re-tab 100% → ack cleared; escape → clear', () => {
    let s = INITIAL_GUARD_STATE;
    const active = true;

    // User types 75% worth (150 units): a new selection, not full.
    s = guardNext(s, { type: 'selection', full: fullFor(150n, active) });
    expect(s.tripped).toBe(false);
    expect(guardBlocksCta(s)).toBe(false);

    // Taps the 100% tab: percentOfWei(200,100)=200 == cap → tripped, un-acked.
    const tab100 = percentOfWei(availableWei, 100);
    s = guardNext(s, { type: 'selection', full: fullFor(tab100, active) });
    expect(s.tripped).toBe(true);
    expect(guardBlocksCta(s)).toBe(true);

    // Acknowledges → CTA unblocked.
    s = guardNext(s, { type: 'ack', value: true });
    expect(guardBlocksCta(s)).toBe(false);

    // Taps 100% AGAIN (same value, still full) — must require fresh consent.
    s = guardNext(s, { type: 'selection', full: fullFor(tab100, active) });
    expect(s.tripped).toBe(true);
    expect(guardBlocksCta(s)).toBe(true);

    // Escape (→75%): guard cleared; the subsequent 75% selection is not full.
    s = guardNext(s, { type: 'escape' });
    s = guardNext(s, { type: 'selection', full: fullFor(percentOfWei(availableWei, 75), active) });
    expect(s.tripped).toBe(false);
    expect(guardBlocksCta(s)).toBe(false);
  });

  test('guard inactive (flag/Sui) never trips even at 100%', () => {
    const s = guardNext(INITIAL_GUARD_STATE, {
      type: 'selection',
      full: fullFor(percentOfWei(availableWei, 100), /* guardActive */ false),
    });
    expect(s.tripped).toBe(false);
    expect(guardBlocksCta(s)).toBe(false);
  });
});
