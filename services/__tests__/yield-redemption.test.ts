import { describe, expect, test } from 'bun:test';
import { describeRedemption, isDefinitiveRelayerRefusal, planYieldRedemption } from '@/services/yield-redemption';
import type { WithdrawalQuote } from '@/hooks/use-relayer';
import { relayerFeeJitterAllowance } from '@/services/relayer-fee-jitter';

const SHARE = '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6';
// /receive semantics: recipient gets the request (10 shares), gross leaving the pool is request + fee.
const REQ = 10_000000000000000000n;
const FEE = 1_000000000000000n;
/** A reviewed fee to measure the drift band against. */
const REVIEWED = 900000000000000n;
const quote = (over: Partial<WithdrawalQuote['feeCommitment']> & { amountSent?: string; feeAmount?: string; topAmountSent?: string } = {}): WithdrawalQuote => ({
  feeAmount: over.feeAmount ?? FEE.toString(),
  gasPrice: '1', txCost: '1',
  amountSent: over.topAmountSent ?? over.amountSent ?? (REQ + FEE).toString(),
  amountReceived: over.amountReceived ?? REQ.toString(),
  relayer: { name: 'r', url: 'https://relayer.example', chainId: 1, chainType: 'evm', status: 'ok', address: '0x2222222222222222222222222222222222222222', processorAddress: '0x3333333333333333333333333333333333333333' } as unknown as WithdrawalQuote['relayer'],
  feeCommitment: {
    data: '0x00', asset: (over.asset ?? SHARE.toLowerCase()) as `0x${string}`, expiration: 9999999999, feeAmount: over.feeAmount ?? FEE.toString(),
    signedRelayerCommitment: '0x00', recipient: '0x1111111111111111111111111111111111111111', amountSent: over.amountSent ?? (REQ + FEE).toString(),
    amountReceived: over.amountReceived ?? REQ.toString(), extraGas: false,
  },
});

describe('planYieldRedemption', () => {
  const requested = REQ;
  test('a /receive quote for the share (recipient = request, gross = request + fee) within the reviewed fee becomes the plan; the gross is the SDK amount', () => {
    const plan = planYieldRedemption({ quote: quote(), shareToken: SHARE, requestedWei: requested, reviewedFeeWei: 2_000000000000000n });
    expect('refusal' in plan).toBe(false);
    if (!('refusal' in plan)) {
      expect(plan.amountOutHex).toBe(`0x${(REQ + FEE).toString(16)}`);
      expect(plan.feeAmount).toBe(FEE.toString());
      expect(plan.feeCommitment.amountReceived).toBe(REQ.toString());
    }
  });
  test('refuses another asset, a recipient leg that is not the request, a gross that is not recipient + fee, a fee above the reviewed fee, junk', () => {
    const r = (q: WithdrawalQuote, reviewed = 2_000000000000000n) => planYieldRedemption({ quote: q, shareToken: SHARE, requestedWei: requested, reviewedFeeWei: reviewed });
    expect('refusal' in r(quote({ asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }))).toBe(true);
    expect('refusal' in r(quote({ amountReceived: (REQ - 1n).toString() }))).toBe(true);
    expect('refusal' in r(quote({ amountSent: (REQ + FEE + 1n).toString() }))).toBe(true);
    expect('refusal' in r(quote(), 500_000000000000n)).toBe(true);
    // Re-quote drift: anything inside the band is the same fee, anything past
    // it is a real increase. Derived from the allowance, not a literal, so this
    // tracks services/relayer-fee-jitter.ts instead of pinning an old value.
    expect('refusal' in r(quote(), FEE - 2n)).toBe(false);
    // Reviewed R accepts exactly R + allowance(R) and refuses one unit more.
    const inBand = REVIEWED + relayerFeeJitterAllowance(REVIEWED);
    const banded = (fee: bigint) => quote({ feeAmount: fee.toString(), amountSent: (REQ + fee).toString() });
    expect('refusal' in r(banded(inBand), REVIEWED)).toBe(false);
    expect('refusal' in r(banded(inBand + 1n), REVIEWED)).toBe(true);
    expect('refusal' in r(quote({ amountSent: 'abc' }))).toBe(true);
  });
  test('decisions read the SIGNED commitment: a low top-level fee over a higher signed fee is refused as a mismatch, never trusted', () => {
    const q = quote();
    const tampered: WithdrawalQuote = { ...q, feeAmount: '1', amountSent: (REQ + 1n).toString() };
    expect('refusal' in planYieldRedemption({ quote: tampered, shareToken: SHARE, requestedWei: requested, reviewedFeeWei: 2_000000000000000n })).toBe(true);
    const lowSigned: WithdrawalQuote = { ...q, feeCommitment: { ...q.feeCommitment, feeAmount: '1', amountSent: (REQ + 1n).toString() } };
    // Top-level says the higher fee, signed says 1 wei: also a mismatch.
    expect('refusal' in planYieldRedemption({ quote: lowSigned, shareToken: SHARE, requestedWei: requested, reviewedFeeWei: 2_000000000000000n })).toBe(true);
  });
});

describe('isDefinitiveRelayerRefusal', () => {
  test('an HTTP 4xx or a simulated revert is definitive; a transport failure is not', () => {
    expect(isDefinitiveRelayerRefusal('HTTP 400: {"message":"processor not supported"}')).toBe(true);
    expect(isDefinitiveRelayerRefusal('PoolVault transact failed: The contract function "transact" reverted. (PoolVault_ProofContextMismatch).')).toBe(true);
    expect(isDefinitiveRelayerRefusal('Failed to fetch')).toBe(false);
    expect(isDefinitiveRelayerRefusal('request timed out after 30000ms')).toBe(false);
    expect(isDefinitiveRelayerRefusal('HTTP 502 Bad Gateway')).toBe(false);
  });
});

describe('describeRedemption', () => {
  test('two decimals in the underlying, both figures', () => {
    expect(describeRedemption({ quotedOut: 9_990_000n, minOut: 9_940_000n, decimals: 6, symbol: 'USDC' })).toBe('about 9.99 USDC (at least 9.94 USDC)');
    expect(describeRedemption({ quotedOut: 5n, minOut: 0n, decimals: 6, symbol: 'USDC' })).toBe('about 0.00 USDC (at least 0.00 USDC)');
  });
});
