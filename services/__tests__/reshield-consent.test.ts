/**
 * Confirm's floor is the reviewed figure minus the slippage the user chose.
 *
 * It was the reviewed figure exactly, so any downward drift refused and a
 * cross-chain reshield could not be completed at all: re-quoting through LiFi
 * moves the output between Review and Confirm essentially always (QA,
 * 2026-09-22).
 */
import { describe, expect, test } from 'bun:test';
import { reshieldConsentFloor, slippageBps } from '@/services/reshield-consent';

const REVIEWED = 47_295_307n; // the figure from the QA screenshot, 6 decimals

describe('the floor follows the control the user set', () => {

  test('0.5% allows half a percent of drift and no more', () => {
    const floor = reshieldConsentFloor(REVIEWED, 0.005)!;
    expect(floor).toBe(47_058_830n);
    // A fresh estimate a tenth of a percent worse now passes, and did not before.
    expect((REVIEWED * 999n) / 1000n >= floor).toBe(true);
    // One a full percent worse still refuses.
    expect((REVIEWED * 99n) / 100n >= floor).toBe(false);
  });

  test('a tighter slippage really is a tighter promise', () => {
    const tight = reshieldConsentFloor(REVIEWED, 0.005)!;
    const loose = reshieldConsentFloor(REVIEWED, 0.03)!;
    expect(loose).toBeLessThan(tight);
    expect(loose).toBe(45_876_447n);
  });

  test('no slippage keeps the old exact floor', () => {
    expect(reshieldConsentFloor(REVIEWED, 0)).toBe(REVIEWED);
    expect(reshieldConsentFloor(REVIEWED, Number.NaN)).toBe(REVIEWED);
  });

  test('nothing reviewed means no gate, not a zero floor', () => {
    expect(reshieldConsentFloor(undefined, 0.005)).toBeUndefined();
  });

  test('a nonsensical slippage cannot invert the floor', () => {
    expect(reshieldConsentFloor(REVIEWED, 5)).toBe(0n);
    expect(reshieldConsentFloor(REVIEWED, -1)).toBe(REVIEWED);
    expect(reshieldConsentFloor(0n, 0.005)).toBe(0n);
  });
});

describe('slippageBps rounds so the floor is never stricter than the label', () => {
  test('a fraction that does not land on a whole bp rounds up', () => {
    expect(slippageBps(0.005)).toBe(50n);
    expect(slippageBps(0.00501)).toBe(51n);
    expect(slippageBps(0.03)).toBe(300n);
    expect(slippageBps(0)).toBe(0n);
  });
});
