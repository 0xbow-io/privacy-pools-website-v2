import { describe, expect, test } from 'bun:test';

import {
  approvalErrorAllowsZeroReset,
  isCapBelowQuoteError,
  isExpiredYieldQuoteError,
  sizeWrapDeposit,
  WRAP_RATE_HEADROOM_PPM,
  YIELD_QUOTE_EXPIRED_MESSAGE,
  validatePreparedYieldDeposit,
  yieldApprovalValues,
  yieldExitDisclosure,
} from '@/services/yield-deposit-safety';

const ROUTER = '0x1111111111111111111111111111111111111111';
const prepared = (overrides: Partial<Parameters<typeof validatePreparedYieldDeposit>[0]> = {}) => ({
  depositTx: { to: ROUTER },
  underlyingNeeded: 99n,
  maxUnderlyingIn: 109n,
  ...overrides,
});

describe('prepared yield deposit safety', () => {
  test('binds the exact app allowance to the reviewed amount when the SDK cap is padded', () => {
    expect(validatePreparedYieldDeposit(prepared(), 100n, ROUTER)).toEqual({ approvalCap: 100n });
  });

  test('keeps a smaller SDK cap but never accepts one below the live underlying need', () => {
    expect(validatePreparedYieldDeposit(prepared({ maxUnderlyingIn: 99n }), 100n, ROUTER))
      .toEqual({ approvalCap: 99n });
    expect(() => validatePreparedYieldDeposit(prepared({ maxUnderlyingIn: 98n }), 100n, ROUTER))
      .toThrow(/invalid spend limit/i);
  });

  test('refuses a different router or a live quote above the reviewed budget before signing', () => {
    expect(() => validatePreparedYieldDeposit(prepared({ depositTx: { to: '0x2222222222222222222222222222222222222222' } }), 100n, ROUTER))
      .toThrow(/different router/i);
    expect(() => validatePreparedYieldDeposit(prepared({ underlyingNeeded: 101n }), 100n, ROUTER))
      .toThrow(/more than the amount you reviewed/i);
  });
});

describe('exact router allowance plan', () => {
  test('does nothing only when the allowance already equals the cap', () => {
    expect(yieldApprovalValues(100n, 100n, 'USDC')).toEqual([]);
  });

  test('approves up and down to the exact cap, including a pre-existing infinite allowance', () => {
    expect(yieldApprovalValues(25n, 100n, 'USDC')).toEqual([100n]);
    expect(yieldApprovalValues((1n << 256n) - 1n, 100n, 'USDC')).toEqual([100n]);
  });

  test('clears a non-zero USDT allowance before setting the exact cap', () => {
    expect(yieldApprovalValues(25n, 100n, 'usdt')).toEqual([0n, 100n]);
    expect(yieldApprovalValues(250n, 100n, 'USDT')).toEqual([0n, 100n]);
    expect(yieldApprovalValues(0n, 100n, 'USDT')).toEqual([100n]);
  });

  test('only a contract-style approval failure permits the zero-reset fallback', () => {
    expect(approvalErrorAllowsZeroReset(new Error('execution reverted: approve from non-zero'))).toBe(true);
    expect(approvalErrorAllowsZeroReset(new Error('User rejected the request'))).toBe(false);
    expect(approvalErrorAllowsZeroReset(new Error('RPC timed out'))).toBe(false);
  });
});

test('yield exit disclosure names the share on both sides of the withdrawal', () => {
  expect(yieldExitDisclosure('USDC')).toBe(
    'You will hold USDC in the yield pool. Withdrawing pays out USDC plus the yield earned, redeemed at the vault.',
  );
});


describe('exact-shares wrap sizing', () => {
  // 100 USDC (6 decimals) at a live rate of 1.000103: previewDeposit = 99.9897 ppUSDC (18 decimals).
  const usdc100 = 100_000_000n;
  const preview = 99_989_693_746_070_480_080n;

  test('the shares are previewDeposit(budget) exactly; the headroom lives in the spend cap', () => {
    const sized = sizeWrapDeposit({ underlying: usdc100, walletBalance: 150_000_000n, previewShares: preview });
    expect(sized.shares).toBe(preview);
    // 2 zap units + 1 ppm of 100 USDC (100 units) = 0.000102 USDC.
    expect(sized.spendCap).toBe(usdc100 + 102n);
    expect(WRAP_RATE_HEADROOM_PPM).toBe(1n);
  });

  test('a Max deposit keeps the cap at the wallet balance and shaves the shares by the same ppm', () => {
    const sized = sizeWrapDeposit({ underlying: usdc100, walletBalance: usdc100, previewShares: preview });
    expect(sized.spendCap).toBe(usdc100);
    expect(sized.shares).toBe((preview * (usdc100 - 102n)) / usdc100);
    // Far from the SDK's 0.5%: the shave is 1 ppm.
    expect(preview - sized.shares).toBeLessThan(preview / 500_000n);
  });

  test('the headroom is the zap buffer plus at least one underlying unit', () => {
    const sized = sizeWrapDeposit({ underlying: 5_000n, walletBalance: 1_000_000n, previewShares: 4_999_000_000_000_000n });
    expect(sized.spendCap).toBe(5_003n);
  });

  test('a vetting fee shrinks the committed shares so value + fee stays inside the budget', () => {
    // 1 bps: 100 USDC of shares × 10000/10001.
    const sized = sizeWrapDeposit({ underlying: usdc100, walletBalance: 150_000_000n, previewShares: preview, vettingFeeBps: 1n });
    expect(sized.shares).toBe((preview * 10_000n) / 10_001n);
    expect(sized.spendCap).toBe(usdc100 + 102n);
    // Modelled router cost previewMint(value + fee) + 2 ≈ underlying + 2 fits the cap.
    const total = sized.shares + (sized.shares * 1n) / 10_000n;
    expect(total).toBeLessThanOrEqual(preview);
  });

  test('refuses a non-positive amount, preview or resulting share count', () => {
    expect(() => sizeWrapDeposit({ underlying: 2n, walletBalance: 2n, previewShares: 1n })).toThrow();
    expect(() => sizeWrapDeposit({ underlying: 0n, walletBalance: 1n, previewShares: 1n })).toThrow();
    expect(() => sizeWrapDeposit({ underlying: 1n, walletBalance: 1n, previewShares: 0n })).toThrow();
  });
});

describe('expired yield quote', () => {
  test('recognises the router and allowance reverts, nothing else', () => {
    expect(isExpiredYieldQuoteError(new Error('execution reverted: PPRouter_SlippageExceeded(99500009, 99500008)'))).toBe(true);
    expect(isExpiredYieldQuoteError(new Error('ERC20: transfer amount exceeds allowance'))).toBe(true);
    expect(isExpiredYieldQuoteError(new Error('ERC20InsufficientAllowance(0xe76e, 99500008, 99500106)'))).toBe(true);
    // A different contract's SlippageExceeded is not the router's.
    expect(isExpiredYieldQuoteError(new Error('UniswapSlippageExceeded()'))).toBe(false);
    expect(isExpiredYieldQuoteError(Object.assign(new Error('Execution reverted'), { shortMessage: 'ERC20: insufficient allowance' }))).toBe(true);
    expect(isExpiredYieldQuoteError(new Error('User rejected the request.'))).toBe(false);
    expect(isExpiredYieldQuoteError(new Error('insufficient funds for gas'))).toBe(false);
    expect(isExpiredYieldQuoteError(undefined)).toBe(false);
  });
  test('the copy says what happened and what to do', () => {
    expect(YIELD_QUOTE_EXPIRED_MESSAGE).toBe('Your deposit has expired: the vault rate moved while it waited. Please try again.');
  });
});

describe('cap below quote at prepare', () => {
  test('only the SDK cap-below-quote shape counts, not other InvalidYieldAmount messages', () => {
    const capErr = Object.assign(new Error('Invalid yield amount: maxUnderlyingIn 100000102 is below the quoted underlyingNeeded 100000103'), { name: 'InvalidYieldAmount' });
    expect(isCapBelowQuoteError(capErr)).toBe(true);
    const badValue = Object.assign(new Error('Invalid yield amount: value must be > 0, got 0'), { name: 'InvalidYieldAmount' });
    expect(isCapBelowQuoteError(badValue)).toBe(false);
    expect(isCapBelowQuoteError(new Error('maxUnderlyingIn 1 is below the quoted underlyingNeeded 2'))).toBe(false);
    expect(isCapBelowQuoteError(undefined)).toBe(false);
  });
});
