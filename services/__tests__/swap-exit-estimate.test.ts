import { describe, expect, test } from 'bun:test';
import { swapExitEstimateInputWei, formatSwapExitEstimate, WITHDRAW_SWAP_FEE_BUFFER_BPS } from '../swap-exit-estimate';

describe('swapExitEstimateInputWei', () => {
  test('mirrors the SDK: gross minus the fee inflated by 30 bps', () => {
    expect(WITHDRAW_SWAP_FEE_BUFFER_BPS).toBe(30n);
    // 2 USDC gross, 23196 fee: SDK routes 2_000_000 − (23196 + 69) = 1_976_735
    expect(swapExitEstimateInputWei({ grossWei: 2_000_000n, feeWei: 23_196n })).toBe(1_976_735n);
  });

  test('before Review there is no fee: estimate on the gross, not on nothing', () => {
    expect(swapExitEstimateInputWei({ grossWei: 2_000_000n, feeWei: null })).toBe(2_000_000n);
    expect(swapExitEstimateInputWei({ grossWei: 2_000_000n, feeWei: 0n })).toBe(2_000_000n);
  });

  test('a fee that eats the amount yields 0, never a negative input', () => {
    expect(swapExitEstimateInputWei({ grossWei: 100n, feeWei: 100n })).toBe(0n);
    expect(swapExitEstimateInputWei({ grossWei: 100n, feeWei: 1_000n })).toBe(0n);
  });

  test('no amount, no estimate', () => {
    expect(swapExitEstimateInputWei({ grossWei: 0n, feeWei: null })).toBe(0n);
  });
});

describe('formatSwapExitEstimate', () => {
  test("Pat's review figure round-trips: 1965811 (6 dp) → 1.965811", () => {
    expect(formatSwapExitEstimate(1_965_811n, 6)).toBe('1.965811');
  });

  test('trims trailing zeros and caps at 6 fractional digits', () => {
    expect(formatSwapExitEstimate(1_500_000n, 6)).toBe('1.5');
    expect(formatSwapExitEstimate(2_000_000n, 6)).toBe('2');
    expect(formatSwapExitEstimate(1_234_567_891_234_567_890n, 18)).toBe('1.234567');
  });

  test('a non-zero amount below display precision is never shown as 0', () => {
    expect(formatSwapExitEstimate(1n, 18)).toBe('0.000000000000000001');
  });

  test('zero is zero', () => {
    expect(formatSwapExitEstimate(0n, 6)).toBe('0');
  });
});
