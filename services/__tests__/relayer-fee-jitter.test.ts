import { describe, expect, test } from 'bun:test';
import { RELAYER_FEE_JITTER_FLOOR_UNITS, feeWithinReviewed, relayerFeeJitterAllowance } from '@/services/relayer-fee-jitter';

describe('relayer fee jitter', () => {
  test('the live refusal: 115356127925068706 against a reviewed 115356127925068704 is the same fee', () => {
    expect(feeWithinReviewed(115356127925068706n, 115356127925068704n)).toBe(true);
  });

  // 2026-09-22, prod, a USDC redemption that refused repeatedly and could not
  // be completed. 325 ppm apart, which is an ordinary constant-gas re-quote and
  // 325 times the old 1 ppb allowance.
  test('the 2026-09-22 refusal at 325 ppm is accepted', () => {
    expect(feeWithinReviewed(483638121340492343n, 483480943603254602n)).toBe(true);
  });

  // The band the relayer was measured at on 2026-09-20 with the gas price held.
  test('the whole measured constant-gas band, 45 to 470 ppm, is accepted', () => {
    const reviewed = 483480943603254602n;
    for (const ppm of [45n, 100n, 325n, 470n]) {
      expect(feeWithinReviewed(reviewed + (reviewed * ppm) / 1_000_000n, reviewed)).toBe(true);
    }
  });

  test('the allowance is 1% of the reviewed fee, never under 16 units', () => {
    expect(relayerFeeJitterAllowance(115356127925068704n)).toBe(1153561279250687n);
    expect(relayerFeeJitterAllowance(1_000n)).toBe(RELAYER_FEE_JITTER_FLOOR_UNITS);
    expect(relayerFeeJitterAllowance(0n)).toBe(0n);
  });

  test('a real increase still fails: one unit past the band', () => {
    const reviewed = 115356127925068704n;
    const allowance = relayerFeeJitterAllowance(reviewed);
    expect(feeWithinReviewed(reviewed + allowance, reviewed)).toBe(true);
    expect(feeWithinReviewed(reviewed + allowance + 1n, reviewed)).toBe(false);
  });

  // A gas-price change between Review and Confirm moves the fee by 1 to 4%.
  // Anything past the band still aborts: the fee really did go up and the user
  // has not seen the new one.
  test('a gas-price change beyond the band still aborts', () => {
    const reviewed = 483480943603254602n;
    expect(feeWithinReviewed(reviewed + (reviewed * 2n) / 100n, reviewed)).toBe(false);
    expect(feeWithinReviewed(reviewed + (reviewed * 4n) / 100n, reviewed)).toBe(false);
    expect(feeWithinReviewed(reviewed * 2n, reviewed)).toBe(false);
  });

  test('a zero reviewed fee tolerates nothing: it cannot tick', () => {
    expect(feeWithinReviewed(0n, 0n)).toBe(true);
    expect(feeWithinReviewed(1n, 0n)).toBe(false);
  });

  test('equal or lower is always fine', () => {
    expect(feeWithinReviewed(5n, 5n)).toBe(true);
    expect(feeWithinReviewed(0n, 5n)).toBe(true);
  });
});
