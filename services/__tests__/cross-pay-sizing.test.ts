import { describe, expect, test } from 'bun:test';
import { sizeConvertingDeposit } from '../cross-pay-sizing';

describe('sizeConvertingDeposit', () => {
  test("Pat's route: 0.226178 USDC deliverable, 1% vetting → a deposit the route can actually fund", () => {
    const deposit = sizeConvertingDeposit({ deliverableMin: 226_178n, vettingFeeBps: 100 });
    // The SDK will ask LiFi for deposit + 1%; that must fit inside the floor.
    const asked = deposit + (deposit * 100n) / 10_000n;
    expect(asked).toBeLessThanOrEqual(226_178n);
    expect(deposit).toBe(222_258n);
  });

  test('the old sizing overshot: 0.242 preview + 1% > 0.226 deliverable', () => {
    const oldTarget = (242_324n * 9925n) / 10_000n;
    const oldAsked = oldTarget + (oldTarget * 100n) / 10_000n;
    expect(oldAsked).toBeGreaterThan(226_178n);
  });

  test('zero vetting fee leaves only the safety margin', () => {
    expect(sizeConvertingDeposit({ deliverableMin: 10_000n, vettingFeeBps: 0 })).toBe(9_925n);
  });

  test('a custom safety margin is honoured', () => {
    expect(sizeConvertingDeposit({ deliverableMin: 10_000n, vettingFeeBps: 0, safetyBps: 0n })).toBe(10_000n);
  });

  test('nothing deliverable, nothing to deposit', () => {
    expect(sizeConvertingDeposit({ deliverableMin: 0n, vettingFeeBps: 100 })).toBe(0n);
  });
});
