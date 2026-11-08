// Withdraw-modal quote identity, mode routing, and race protection
// (services/withdraw-quotes + the shared guard from services/intent-swaps).
//
// These pin the production sequences behind the codex P1/P2 findings:
//  - the review handler registers the FULL canonical request key BEFORE its
//    first await; an edit during the deferred registration/quote awaits
//    invalidates the old continuation (stale recipient A → B),
//  - a "Receive as" change invalidates pending plain AND batch quotes
//    (mode + output token live in the key, one guard covers every mode),
//  - batch-only 100%/Max semantics are never offered to the swap route
//    (route-specific availability over two-label and >5-note topologies),
//  - Confirm requires the reviewed context (chain / session / mode / modal
//    epoch) to match the live one.

import { describe, expect, test } from 'bun:test';

import { createSwapRequestGuard } from '@/services/intent-swaps';
import {
  buildWithdrawQuoteKey,
  topNAcrossLabels,
  resolveDisplayAvailableWei,
  resolveGrossLeavingWei,
  resolveRemainingBalanceWei,
  resolveEffectiveReceiveExact,
  resolveSingleProofMaxInputWei,
  resolveWithdrawPercentSelection,
  resolveWithdrawMode,
  reviewContextMatches,
  type WithdrawReviewContext,
} from '@/services/withdraw-quotes';

const SEPOLIA = 11155111;
const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const RECIPIENT_A = '0x1111111111111111111111111111111111111111';
const RECIPIENT_B = '0x2222222222222222222222222222222222222222';
const OWNER = '0x9999999999999999999999999999999999999999';

function key(overrides: Partial<Parameters<typeof buildWithdrawQuoteKey>[0]> = {}) {
  return buildWithdrawQuoteKey({
    sessionKey: `${OWNER}:${SEPOLIA}`,
    epoch: 1,
    mode: 'plain',
    poolChainId: SEPOLIA,
    inputToken: ETH,
    amount: '1.5',
    outputToken: ETH,
    recipient: RECIPIENT_A,
    gasToken: false,
    receiveExact: true,
    spendabilityKey: 'notes-v1',
    ...overrides,
  });
}

describe('buildWithdrawQuoteKey (canonical request identity)', () => {
  test('distinguishes every quote-relevant field', () => {
    const base = key();
    expect(key({ recipient: RECIPIENT_B })).not.toBe(base);
    expect(key({ amount: '1.50001' })).not.toBe(base);
    expect(key({ inputToken: USDC })).not.toBe(base);
    expect(key({ outputToken: USDC })).not.toBe(base);
    expect(key({ mode: 'swap' })).not.toBe(base);
    expect(key({ mode: 'batch' })).not.toBe(base);
    expect(key({ poolChainId: 1 })).not.toBe(base);
    expect(key({ sessionKey: `${RECIPIENT_B}:${SEPOLIA}` })).not.toBe(base);
    expect(key({ epoch: 2 })).not.toBe(base);
    expect(key({ gasToken: true })).not.toBe(base);
    expect(key({ receiveExact: false })).not.toBe(base);
    expect(key({ spendabilityKey: 'notes-v2' })).not.toBe(base);
    expect(key({ mode: 'swap', slippage: 0.005 })).not.toBe(key({ mode: 'swap', slippage: 0.01 }));
  });

  test('is case-insensitive over addresses (checksummed == lowercased)', () => {
    expect(key({ recipient: RECIPIENT_A.toUpperCase().replace('0X', '0x') })).toBe(key());
    expect(key({ outputToken: USDC })).toBe(key({ outputToken: USDC.toLowerCase() }));
  });
});

describe('deferred-registration recipient race (codex P1: relay to A while Review shows B)', () => {
  test('begin() before the first await + an edit invalidates the old continuation', () => {
    const guard = createSwapRequestGuard();
    // Review clicked with recipient A: the handler builds the full key and
    // begins BEFORE awaiting SDK init / isKeystoreRegistered().
    const keyA = key({ recipient: RECIPIENT_A });
    const tokenA = guard.begin(keyA);
    // While the registration RPC is pending the user edits the recipient to
    // B — every edit handler invalidates the shared guard.
    guard.invalidate();
    // The old continuation resumes after its await: it must NOT be current
    // (pre-fix it called begin() here and made itself current again).
    expect(guard.isCurrent(tokenA, keyA)).toBe(false);
    // A new review pass for B is the only current request.
    const keyB = key({ recipient: RECIPIENT_B });
    const tokenB = guard.begin(keyB);
    expect(guard.isCurrent(tokenA, keyA)).toBe(false);
    expect(guard.isCurrent(tokenB, keyB)).toBe(true);
  });
});

describe('pending plain/batch quote vs a "Receive as" change (codex P1)', () => {
  test('an invalidated late response cannot repopulate the accepted fee slot', () => {
    const guard = createSwapRequestGuard();
    const plainKey = key({ amount: '1' });
    const plainToken = guard.begin(plainKey);
    let acceptedFee: bigint | null = null;

    // Production clears its provider-owned accepted quote in the same handler
    // that invalidates the request. React Query may still resolve internally,
    // but only the guarded continuation is allowed to write this slot.
    guard.invalidate();
    acceptedFee = null;
    if (guard.isCurrent(plainToken, plainKey)) acceptedFee = 50n;

    expect(acceptedFee).toBeNull();
  });

  test('plain → swap: the receive-asset change invalidates the in-flight plain quote', () => {
    const guard = createSwapRequestGuard();
    const plainKey = key({ mode: 'plain', outputToken: ETH });
    const plainToken = guard.begin(plainKey);
    // User picks USDC as the receive asset while the plain quote is pending:
    // the handler invalidates every request and clears reviewed state.
    guard.invalidate();
    expect(guard.isCurrent(plainToken, plainKey)).toBe(false);
    // The next review pass runs in swap mode with the output token in its key.
    const swapKey = key({ mode: 'swap', outputToken: USDC, slippage: 0.005 });
    const swapToken = guard.begin(swapKey);
    expect(swapKey).not.toBe(plainKey);
    expect(guard.isCurrent(swapToken, swapKey)).toBe(true);
    // Late arrival of the plain response can never commit.
    expect(guard.isCurrent(plainToken, plainKey)).toBe(false);
  });

  test('batch → swap: same shared guard, same invalidation', () => {
    const guard = createSwapRequestGuard();
    const batchKey = key({ mode: 'batch', outputToken: ETH });
    const batchToken = guard.begin(batchKey);
    guard.invalidate();
    const swapKey = key({ mode: 'swap', outputToken: USDC, slippage: 0.005 });
    guard.begin(swapKey);
    expect(guard.isCurrent(batchToken, batchKey)).toBe(false);
  });

  test('even without an explicit invalidate, mode/output are in the key so a stale response loses', () => {
    const guard = createSwapRequestGuard();
    const plainKey = key({ mode: 'plain', outputToken: ETH });
    const plainToken = guard.begin(plainKey);
    // Defensive path: a newer swap request supersedes without invalidate().
    const swapKey = key({ mode: 'swap', outputToken: USDC, slippage: 0.005 });
    guard.begin(swapKey);
    expect(guard.isCurrent(plainToken, plainKey)).toBe(false);
  });
});

describe('resolveWithdrawMode (branch priority)', () => {
  test('a swap exit ALWAYS wins over batch eligibility (both flags on)', () => {
    expect(resolveWithdrawMode({ isSui: false, isSwapExit: true, batchEligible: true })).toBe('swap');
  });
  test('batch only without a swap exit', () => {
    expect(resolveWithdrawMode({ isSui: false, isSwapExit: false, batchEligible: true })).toBe('batch');
    expect(resolveWithdrawMode({ isSui: false, isSwapExit: false, batchEligible: false })).toBe('plain');
  });
  test('Sui wins over everything', () => {
    expect(resolveWithdrawMode({ isSui: true, isSwapExit: true, batchEligible: true })).toBe('sui');
  });
});

describe('route-specific availability (codex P2: batch-only Max offered to the swap route)', () => {
  // Two-label topology: label A = 3 notes of 10, label B = 2 notes of 40.
  const notes = [
    { label: '0xa', value: 10n },
    { label: '0xa', value: 10n },
    { label: '0xa', value: 10n },
    { label: '0xb', value: 40n },
    { label: '0xb', value: 40n },
  ];
  const mixedLabelCap = topNAcrossLabels(notes, 5);
  const spendable = 110n; // 30 + 80 across both labels

  test('two-label topology: the mixed-label cap is the top 5 notes across labels', () => {
    expect(mixedLabelCap).toBe(110n);
  });

  test('>5-note topology: one label is capped at its top 5 notes', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ label: '0xa', value: BigInt(i + 1) }));
    // top 5 of 1..8 = 8+7+6+5+4 = 30, not 36.
    expect(topNAcrossLabels(many, 5)).toBe(30n);
    expect(topNAcrossLabels(many, 99)).toBe(30n);
  });

  test('DEV-408: one token spelled two ways is one group (the SDK takes mixed casing in one proof)', () => {
    const casingVariants = [
      { tokenId: '0xAbCd', label: '0xa', value: 60n },
      { tokenId: '0xabcd', label: '0xb', value: 50n },
    ];
    expect(topNAcrossLabels(casingVariants, 5)).toBe(110n);
    // Different tokens still never combine.
    expect(topNAcrossLabels([...casingVariants, { tokenId: '0xef01', label: '0xc', value: 200n }], 5)).toBe(200n);
  });

  test('swap exit advertises the single-proof mixed-label cap even with batching enabled, never the batch balance', () => {
    // Since 2026-09-04 the swap exit spends any labels in one proof (Pat, prod:
    // two 0.004 ETH deposits, 0.005 ETH swap); the cap is the top-5 sum.
    const bigger = [...notes, { label: '0xc', value: 5n }]; // 6 notes, spendable 115
    expect(resolveDisplayAvailableWei({
      isSwapExit: true,
      batchEnabled: true,
      spendableWei: 115n,
      singleProofCapWei: topNAcrossLabels(bigger, 5),
    })).toBe(110n);
  });

  test('plain route with batching advertises the whole balance; without it, the mixed-label cap', () => {
    expect(resolveDisplayAvailableWei({
      isSwapExit: false,
      batchEnabled: true,
      spendableWei: spendable,
      singleProofCapWei: mixedLabelCap,
    })).toBe(110n);
    expect(resolveDisplayAvailableWei({
      isSwapExit: false,
      batchEnabled: false,
      spendableWei: spendable,
      singleProofCapWei: mixedLabelCap,
    })).toBe(110n);
  });
});

describe('fee-aware one-proof admission', () => {
  test('receive-exact adds the fee to gross and reserves it from the input maximum', () => {
    expect(resolveGrossLeavingWei({ enteredWei: 100n, feeWei: 7n, receiveExact: true })).toBe(107n);
    expect(resolveSingleProofMaxInputWei({
      singleProofCapWei: 100n,
      feeWei: 7n,
      receiveExact: true,
    })).toBe(93n);
  });

  test('gross mode leaves the entered amount and cap unchanged', () => {
    expect(resolveGrossLeavingWei({ enteredWei: 100n, feeWei: 7n, receiveExact: false })).toBe(100n);
    expect(resolveSingleProofMaxInputWei({
      singleProofCapWei: 100n,
      feeWei: 7n,
      receiveExact: false,
    })).toBe(100n);
  });

  test('a fee consuming the cap leaves no valid receive-exact input', () => {
    expect(resolveSingleProofMaxInputWei({
      singleProofCapWei: 7n,
      feeWei: 7n,
      receiveExact: true,
    })).toBe(0n);
  });

  test('whole-balance and one-proof Max are gross; smaller entries keep receive-exact', () => {
    const base = {
      requestedReceiveExact: true,
      totalBalanceWei: 200n,
      singleProofCapWei: 100n,
    };
    expect(resolveEffectiveReceiveExact({ ...base, enteredWei: 200n })).toBe(false);
    expect(resolveEffectiveReceiveExact({ ...base, enteredWei: 100n })).toBe(false);
    expect(resolveEffectiveReceiveExact({ ...base, enteredWei: 99n })).toBe(true);
    expect(resolveEffectiveReceiveExact({ ...base, requestedReceiveExact: false, enteredWei: 99n })).toBe(false);
  });

  test('remaining balance subtracts from the whole balance, not the proof cap', () => {
    expect(resolveRemainingBalanceWei({ totalBalanceWei: 200n, grossLeavingWei: 75n })).toBe(125n);
    expect(resolveRemainingBalanceWei({ totalBalanceWei: 200n, grossLeavingWei: 205n })).toBe(0n);
  });
});

describe('route-aware percent selections', () => {
  test('plain and swap percentages use their explicitly supplied destination caps', () => {
    expect(resolveWithdrawPercentSelection({
      pct: 100,
      isSwapExit: true,
      batchEnabled: true,
      spendableWei: 200n,
      singleProofCapWei: 80n,
    })).toEqual({ amountWei: 80n, maxSelected: false });
    expect(resolveWithdrawPercentSelection({
      pct: 50,
      isSwapExit: false,
      batchEnabled: false,
      spendableWei: 200n,
      singleProofCapWei: 150n,
    })).toEqual({ amountWei: 75n, maxSelected: false });
  });

  test('plain 100% with batching keeps the explicit whole-balance route', () => {
    expect(resolveWithdrawPercentSelection({
      pct: 100,
      isSwapExit: false,
      batchEnabled: true,
      spendableWei: 200n,
      singleProofCapWei: 150n,
    })).toEqual({ amountWei: 200n, maxSelected: true });
  });
});

describe('reviewContextMatches (codex P1: Confirm requires the reviewed context)', () => {
  const ctx: WithdrawReviewContext = {
    mode: 'swap',
    poolChainId: SEPOLIA,
    sessionKey: `${OWNER.toLowerCase()}:${SEPOLIA}`,
    epoch: 3,
    recipient: RECIPIENT_A,
    spendabilityKey: 'notes-v1',
  };
  const live = {
    isSui: false,
    poolChainId: SEPOLIA,
    sessionKey: `${OWNER}:${SEPOLIA}`,
    epoch: 3,
    spendabilityKey: 'notes-v1',
  };

  test('matches the exact reviewed context (session key case-insensitive)', () => {
    expect(reviewContextMatches(ctx, live)).toBe(true);
  });
  test('no review yet → never matches', () => {
    expect(reviewContextMatches(null, live)).toBe(false);
  });
  test('modal close/reopen (epoch bump) invalidates the review', () => {
    expect(reviewContextMatches(ctx, { ...live, epoch: 4 })).toBe(false);
  });
  test('chain switch invalidates the review', () => {
    expect(reviewContextMatches(ctx, { ...live, poolChainId: 1 })).toBe(false);
  });
  test('account/session switch invalidates the review', () => {
    expect(reviewContextMatches(ctx, { ...live, sessionKey: `${RECIPIENT_B}:${SEPOLIA}` })).toBe(false);
  });
  test('a note or approval topology change invalidates the review', () => {
    expect(reviewContextMatches(ctx, { ...live, spendabilityKey: 'notes-v2' })).toBe(false);
  });
  test('an EVM review can never run the Sui branch (and vice versa)', () => {
    expect(reviewContextMatches(ctx, { ...live, isSui: true })).toBe(false);
    const suiCtx: WithdrawReviewContext = { ...ctx, mode: 'sui' };
    expect(reviewContextMatches(suiCtx, { ...live, isSui: true })).toBe(true);
    expect(reviewContextMatches(suiCtx, live)).toBe(false);
  });
});

describe('topNAcrossLabels (mixed-label per-proof cap)', () => {
  const note = (value: string, label: string) => ({ value, label });

  test("Artem's case: two 0.01 deposits under different labels cap at 0.02, not 0.01", () => {
    const notes = [note('10000000000000000', 'a'), note('10000000000000000', 'b')];
    expect(topNAcrossLabels(notes, 5)).toBe(20000000000000000n);
  });

  test('takes only the largest maxInputs notes, labels ignored', () => {
    const notes = [
      note('5', 'a'), note('4', 'b'), note('3', 'a'), note('2', 'c'), note('1', 'b'), note('9', 'd'),
    ];
    // top-5 of [9,5,4,3,2,1] = 9+5+4+3+2
    expect(topNAcrossLabels(notes, 5)).toBe(23n);
  });

  test('fewer notes than the cap sums them all; empty is 0', () => {
    expect(topNAcrossLabels([note('7', 'x')], 5)).toBe(7n);
    expect(topNAcrossLabels([], 5)).toBe(0n);
  });
});

describe('DEV-408: the swap shortfall names the coin and marks share amounts approximate', () => {
  test('a ppUSDT shortfall reads as USDT, with ≈ on each share figure', async () => {
    const { noteShortfallMessage } = await import('@/services/swap-note-shortfall');
    const msg = noteShortfallMessage({ reason: 'input-cap', selectableWei: 18_972789n, withheldWei: 0n }, { symbol: 'ppUSDT', decimals: 6 });
    expect(msg).not.toContain('ppUSDT');
    expect(msg).toContain('≈ 18.972789 USDT');
    const waiting = noteShortfallMessage({ reason: 'unapproved', selectableWei: 0n, withheldWei: 5_000000n }, { symbol: 'ppUSDT', decimals: 6 });
    expect(waiting).toBe('None of your USDT notes are approved yet. ≈ 5 USDT is waiting.');
  });
  test('a plain token is unchanged', async () => {
    const { noteShortfallMessage } = await import('@/services/swap-note-shortfall');
    expect(noteShortfallMessage({ reason: 'insufficient', selectableWei: 2_000000n, withheldWei: 0n }, { symbol: 'USDC', decimals: 6 }))
      .toBe('Your approved USDC notes come to 2 USDC.');
  });
});
