import { describe, expect, test } from 'bun:test';

import {
  ZERO_ADDRESS,
  isCrossChainSwap,
  isZeroAddress,
  resolveSwapDelivery,
  validateSwapRouteEcho,
  validatePreparedSwapQuote,
  formatTokenUnits,
  shapeSwapQuoteForDisplay,
  buildRelayWithdrawAndSwapParams,
  selectSwapInputNotes,
  isSuccessfulSwapReceipt,
  isSwapUnavailableError,
  isNoRouteError,
  getPreparedQuoteExpiration,
  hasUsableCommitmentLifetime,
  isFreshCommitmentLive,
  validateRefreshedSwapQuote,
  SWAP_PROVING_SAFETY_WINDOW_MS,
  buildSwapQuoteRequestKey,
  createSwapRequestGuard,
  resolveSwapAvailability,
  type PreparedSwapQuoteLike,
} from '@/services/intent-swaps';
import { NoteStatus, type Note } from '@/services/sdk-types';

const SEPOLIA = 11155111;
const OPTIMISM = 10;
const RECIPIENT = '0x1111111111111111111111111111111111111111' as const;
const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const;
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as const;
const GROSS = 10n ** 18n; // 1 ETH reviewed gross

describe('swap availability gate (blocker: processor binding)', () => {
  test('flag alone is not enough. A configured RelaySwaps processor is required', () => {
    expect(resolveSwapAvailability(true, undefined)).toBe(false);
    expect(resolveSwapAvailability(false, RECIPIENT)).toBe(false);
    expect(resolveSwapAvailability(true, RECIPIENT)).toBe(true);
  });
});

describe('isCrossChainSwap', () => {
  test('same chain / omitted destination are not cross-chain', () => {
    expect(isCrossChainSwap(SEPOLIA, SEPOLIA)).toBe(false);
    expect(isCrossChainSwap(SEPOLIA, undefined)).toBe(false);
  });
  test('different destination is cross-chain', () => {
    expect(isCrossChainSwap(SEPOLIA, OPTIMISM)).toBe(true);
  });
});

describe('resolveSwapDelivery', () => {
  test('same-chain keeps the recipient on-chain with on-chain min enforcement', () => {
    const d = resolveSwapDelivery({ poolChainId: SEPOLIA, toChainId: SEPOLIA, recipientAddress: RECIPIENT });
    expect(d.mode).toBe('same-chain');
    expect(d.onChainRecipient).toBe(RECIPIENT);
    expect(d.minOutputEnforcement).toBe('on-chain');
  });

  test('cross-chain uses the address(0) sentinel and delegates min enforcement', () => {
    const d = resolveSwapDelivery({ poolChainId: SEPOLIA, toChainId: OPTIMISM, recipientAddress: RECIPIENT });
    expect(d.mode).toBe('cross-chain');
    expect(d.onChainRecipient).toBe(ZERO_ADDRESS);
    expect(d.minOutputEnforcement).toBe('destination-executor');
  });
});

describe('validateSwapRouteEcho', () => {
  const requested = { fromChainId: SEPOLIA, toChainId: SEPOLIA, fromToken: ETH, toToken: USDC };

  test('accepts a matching echo (addresses case-insensitive)', () => {
    expect(validateSwapRouteEcho(requested, {
      fromChainId: SEPOLIA,
      toChainId: SEPOLIA,
      fromTokenAddress: ETH.toUpperCase().replace('0X', '0x') as `0x${string}`,
      toTokenAddress: USDC.toLowerCase() as `0x${string}`,
    })).toEqual([]);
  });

  test('flags every mismatched leg', () => {
    const problems = validateSwapRouteEcho(requested, {
      fromChainId: 1,
      toChainId: OPTIMISM,
      fromTokenAddress: USDC,
      toTokenAddress: ETH,
    });
    expect(problems).toHaveLength(4);
  });
});

describe('formatTokenUnits', () => {
  test('formats whole and fractional amounts', () => {
    expect(formatTokenUnits(1000000000000000000n, 18)).toBe('1');
    expect(formatTokenUnits(1234500n, 6)).toBe('1.2345');
    expect(formatTokenUnits(0n, 6)).toBe('0');
  });
  test('caps fraction digits', () => {
    expect(formatTokenUnits(1123456789012345678n, 18, 4)).toBe('1.1234');
  });
  test('never renders nonzero money as zero (1 wei, 1 micro-USDC)', () => {
    expect(formatTokenUnits(1n, 18)).toBe('0.000000000000000001');
    expect(formatTokenUnits(1n, 6)).toBe('0.000001');
    expect(formatTokenUnits(123n, 18)).toBe('0.000000000000000123');
    // Above the precision floor the cap still applies.
    expect(formatTokenUnits(1500000n, 6, 2)).toBe('1.5');
  });
});

// Same-chain coherent fixture: net 0.99 ETH + fee 0.01 ETH = gross 1 ETH;
// on-chain min equals LiFi's destination min (1 USDC).
function makePrepared(overrides: Partial<PreparedSwapQuoteLike> = {}): PreparedSwapQuoteLike {
  return {
    selectedQuote: { relayerInfo: { name: '0xbow Relayer' }, quote: { feeCommitment: { expiration: 1_700_000_060_000 } } },
    swapCalldata: '0xdeadbeef',
    minOutputAmount: '0xf4240', // 1_000_000 (1 USDC)
    destinationMinOutputAmount: '0xf4240',
    feeAmount: '10000000000000000', // 0.01 ETH
    netAmount: '0xdbd2fc137a30000', // 0.99 ETH
    estimatedOutput: '1050000', // 1.05 USDC
    swapTarget: '0x2222222222222222222222222222222222222222',
    approvalAddress: '0x3333333333333333333333333333333333333333',
    dustRecipient: RECIPIENT,
    toChainId: SEPOLIA,
    ...overrides,
  };
}

function makeCrossPrepared(overrides: Partial<PreparedSwapQuoteLike> = {}): PreparedSwapQuoteLike {
  return makePrepared({
    toChainId: OPTIMISM,
    minOutputAmount: '0x0',
    destinationMinOutputAmount: '0xe8d4a51000',
    ...overrides,
  });
}

describe('shapeSwapQuoteForDisplay', () => {
  test('same-chain: minReceived is the on-chain enforced minOutputAmount', () => {
    const display = shapeSwapQuoteForDisplay(makePrepared(), {
      poolChainId: SEPOLIA,
      inputDecimals: 18,
      outputDecimals: 6,
    });
    expect(display.mode).toBe('same-chain');
    expect(display.minReceived).toBe('1');
    expect(display.estimatedOutput).toBe('1.05');
    expect(display.relayerFee).toBe('0.01');
    expect(display.netSwapped).toBe('0.99');
    // 1.05 output / 0.99 input ≈ 1.0606…
    expect(display.rate.startsWith('1.06')).toBe(true);
  });

  test('cross-chain: minReceived falls back to destinationMinOutputAmount', () => {
    const display = shapeSwapQuoteForDisplay(makeCrossPrepared(), {
      poolChainId: SEPOLIA,
      inputDecimals: 18,
      outputDecimals: 6,
    });
    expect(display.mode).toBe('cross-chain');
    // 0xe8d4a51000 = 1_000_000_000_000 → 1,000,000 at 6 decimals
    expect(display.minReceived).toBe('1000000');
  });
});

describe('validatePreparedSwapQuote', () => {
  test('accepts a coherent same-chain quote', () => {
    expect(validatePreparedSwapQuote(makePrepared(), {
      poolChainId: SEPOLIA,
      grossWei: GROSS,
      recipientAddress: RECIPIENT,
    })).toEqual([]);
  });

  test('rejects a committed gross that differs from the reviewed amount', () => {
    // Hostile commitment: amountSent above what the user reviewed.
    const problems = validatePreparedSwapQuote(makePrepared(), {
      poolChainId: SEPOLIA,
      grossWei: GROSS - 1n,
      recipientAddress: RECIPIENT,
    });
    expect(problems.some((p) => p.includes('does not equal the reviewed amount'))).toBe(true);
  });

  test('rejects same-chain zero minOutputAmount (disables the on-chain output check)', () => {
    const problems = validatePreparedSwapQuote(
      makePrepared({ minOutputAmount: '0x0', destinationMinOutputAmount: '0x0' }),
      { poolChainId: SEPOLIA, grossWei: GROSS, recipientAddress: RECIPIENT },
    );
    expect(problems.some((p) => p.includes('must be positive'))).toBe(true);
  });

  test('rejects same-chain min/destination-min divergence', () => {
    const problems = validatePreparedSwapQuote(
      makePrepared({ destinationMinOutputAmount: '0xf4241' }),
      { poolChainId: SEPOLIA, grossWei: GROSS, recipientAddress: RECIPIENT },
    );
    expect(problems.some((p) => p.includes('does not equal destination minimum'))).toBe(true);
  });

  test('rejects zero recipient / fallback / dust recipient', () => {
    expect(validatePreparedSwapQuote(makePrepared(), {
      poolChainId: SEPOLIA,
      grossWei: GROSS,
      recipientAddress: ZERO_ADDRESS,
    }).some((p) => p.includes('recipient is the zero address'))).toBe(true);

    expect(validatePreparedSwapQuote(makeCrossPrepared(), {
      poolChainId: SEPOLIA,
      grossWei: GROSS,
      recipientAddress: RECIPIENT,
      fallbackAddress: ZERO_ADDRESS,
    }).some((p) => p.includes('fallback address is the zero address'))).toBe(true);

    expect(validatePreparedSwapQuote(makePrepared({ dustRecipient: ZERO_ADDRESS }), {
      poolChainId: SEPOLIA,
      grossWei: GROSS,
      recipientAddress: RECIPIENT,
    }).some((p) => p.includes('dust recipient'))).toBe(true);
  });

  test('cross-chain: requires zero on-chain min, positive destination min, explicit fallback', () => {
    // Valid cross-chain quote.
    expect(validatePreparedSwapQuote(makeCrossPrepared(), {
      poolChainId: SEPOLIA,
      grossWei: GROSS,
      recipientAddress: RECIPIENT,
      fallbackAddress: RECIPIENT,
    })).toEqual([]);
    // Nonzero on-chain min is a protocol violation cross-chain.
    expect(validatePreparedSwapQuote(makeCrossPrepared({ minOutputAmount: '0x1' }), {
      poolChainId: SEPOLIA,
      grossWei: GROSS,
      recipientAddress: RECIPIENT,
      fallbackAddress: RECIPIENT,
    }).some((p) => p.includes('must be 0'))).toBe(true);
    // Zero destination minimum means no slippage protection anywhere.
    expect(validatePreparedSwapQuote(makeCrossPrepared({ destinationMinOutputAmount: '0x0' }), {
      poolChainId: SEPOLIA,
      grossWei: GROSS,
      recipientAddress: RECIPIENT,
      fallbackAddress: RECIPIENT,
    }).some((p) => p.includes('destination minimum output must be positive'))).toBe(true);
    // Missing fallback for cross-chain.
    expect(validatePreparedSwapQuote(makeCrossPrepared(), {
      poolChainId: SEPOLIA,
      grossWei: GROSS,
      recipientAddress: RECIPIENT,
    }).some((p) => p.includes('explicit fallback'))).toBe(true);
  });

  test('isZeroAddress recognizes the sentinel only', () => {
    expect(isZeroAddress(ZERO_ADDRESS)).toBe(true);
    expect(isZeroAddress(RECIPIENT)).toBe(false);
  });
});

describe('commitment lifetime', () => {
  test('reads the signed expiration off the prepared quote', () => {
    expect(getPreparedQuoteExpiration(makePrepared())).toBe(1_700_000_060_000);
    expect(getPreparedQuoteExpiration(makePrepared({ selectedQuote: {} }))).toBeUndefined();
  });

  test('requires the full proving-budget window (p99 proof + submission), not merely non-expired', () => {
    const expiration = 1_700_000_060_000;
    // 90s left > 50s window -> usable.
    expect(hasUsableCommitmentLifetime(expiration, expiration - 90_000)).toBe(true);
    // 40s left would cover the OLD 20s window but NOT a 30-60s proof —
    // must be refused (codex P2: gate shorter than the proving time).
    expect(hasUsableCommitmentLifetime(expiration, expiration - 40_000)).toBe(false);
    // 10s left < window → confirm must re-quote instead of proving.
    expect(hasUsableCommitmentLifetime(expiration, expiration - 10_000)).toBe(false);
    // Exactly at the window is not usable; Confirm refreshes instead of proving.
    expect(hasUsableCommitmentLifetime(expiration, expiration - SWAP_PROVING_SAFETY_WINDOW_MS)).toBe(false);
    expect(hasUsableCommitmentLifetime(expiration, expiration - SWAP_PROVING_SAFETY_WINDOW_MS - 1)).toBe(true);
    // Already expired.
    expect(hasUsableCommitmentLifetime(expiration, expiration + 1)).toBe(false);
    // No expiration on the quote → fail closed.
    expect(hasUsableCommitmentLifetime(undefined, expiration)).toBe(false);
    // Custom window.
    expect(hasUsableCommitmentLifetime(expiration, expiration - 30_000, 25_000)).toBe(true);
  });
});

describe('quote request guard', () => {
  const key = (gross: bigint) => buildSwapQuoteRequestKey({
    sessionKey: 'owner:11155111',
    poolChainId: SEPOLIA,
    inputToken: ETH,
    grossWei: gross,
    destinationChainId: SEPOLIA,
    outputToken: USDC,
    recipient: RECIPIENT,
    slippage: 0.005,
  });

  test('the newest request wins; older completions are discarded', () => {
    const guard = createSwapRequestGuard();
    const a = guard.begin(key(1n));
    const b = guard.begin(key(2n)); // user edited amount, re-quoted
    // A completes late (out of order): must not commit.
    expect(guard.isCurrent(a, key(1n))).toBe(false);
    expect(guard.isCurrent(b, key(2n))).toBe(true);
  });

  test('any edit/close/reset invalidates the in-flight request', () => {
    const guard = createSwapRequestGuard();
    const t = guard.begin(key(1n));
    guard.invalidate(); // edit or close while fetching
    expect(guard.isCurrent(t, key(1n))).toBe(false);
  });

  test('a stale token with a matching key still loses to a newer request', () => {
    const guard = createSwapRequestGuard();
    const t1 = guard.begin(key(1n));
    const t2 = guard.begin(key(1n)); // same key re-requested
    expect(guard.isCurrent(t1, key(1n))).toBe(false);
    expect(guard.isCurrent(t2, key(1n))).toBe(true);
  });

  test('the canonical key distinguishes every quote-relevant field', () => {
    const base = key(1n);
    expect(key(2n)).not.toBe(base);
    expect(buildSwapQuoteRequestKey({
      sessionKey: 'owner:11155111',
      poolChainId: SEPOLIA,
      inputToken: ETH,
      grossWei: 1n,
      destinationChainId: OPTIMISM,
      outputToken: USDC,
      recipient: RECIPIENT,
      fallback: RECIPIENT,
      slippage: 0.005,
    })).not.toBe(base);
  });
});

describe('buildRelayWithdrawAndSwapParams', () => {
  test('passes the NET amount and echoes the signed routing tuple', () => {
    const prepared = makePrepared();
    const params = buildRelayWithdrawAndSwapParams({
      prepared,
      poolChainId: SEPOLIA,
      grossWei: GROSS,
      inputCommitments: ['0xaaaa'],
      tokenId: ETH,
      outputToken: USDC,
      recipientAddress: RECIPIENT,
    });
    expect(params.amount).toBe(prepared.netAmount); // never the gross input
    expect(params.minOutputAmount).toBe(prepared.minOutputAmount);
    expect(params.swapCalldata).toBe(prepared.swapCalldata);
    expect(params.selectedQuote).toBe(prepared.selectedQuote);
    expect(params.toChainId).toBe(prepared.toChainId);
    expect(params.dustRecipient).toBe(prepared.dustRecipient);
    expect(params.swapTarget).toBe(prepared.swapTarget);
    expect(params.approvalAddress).toBe(prepared.approvalAddress);
    expect(params.outputToken).toBe(USDC);
    expect(params.recipientAddress).toBe(RECIPIENT);
    expect('fallbackAddress' in params).toBe(false);
  });

  test('carries an explicit fallbackAddress when provided (cross-chain)', () => {
    const params = buildRelayWithdrawAndSwapParams({
      prepared: makeCrossPrepared(),
      poolChainId: SEPOLIA,
      grossWei: GROSS,
      inputCommitments: ['0xaaaa'],
      tokenId: ETH,
      outputToken: USDC,
      recipientAddress: RECIPIENT,
      fallbackAddress: '0x4444444444444444444444444444444444444444',
    });
    expect(params.fallbackAddress).toBe('0x4444444444444444444444444444444444444444');
  });

  test('THROWS on an invalid quote. The builder is the last gate before proving', () => {
    // Gross mismatch (hostile amountSent).
    expect(() => buildRelayWithdrawAndSwapParams({
      prepared: makePrepared(),
      poolChainId: SEPOLIA,
      grossWei: GROSS + 1n,
      inputCommitments: ['0xaaaa'],
      tokenId: ETH,
      outputToken: USDC,
      recipientAddress: RECIPIENT,
    })).toThrow(/does not equal the reviewed amount/);
    // Zero recipient.
    expect(() => buildRelayWithdrawAndSwapParams({
      prepared: makePrepared(),
      poolChainId: SEPOLIA,
      grossWei: GROSS,
      inputCommitments: ['0xaaaa'],
      tokenId: ETH,
      outputToken: USDC,
      recipientAddress: ZERO_ADDRESS,
    })).toThrow(/zero address/);
  });
});

function makeNote(value: bigint, label: string, i: number, tokenId: Note['tokenId'] = ETH): Note {
  return {
    commitment: `0x${(i + 1).toString(16).padStart(4, '0')}` as `0x${string}`,
    value: `0x${value.toString(16)}` as `0x${string}`,
    tokenId,
    label: label as `0x${string}`,
    status: NoteStatus.ACTIVE,
    ownerAddress: RECIPIENT,
    noteSecret: '0x01',
    isOwned: true,
    createdAtBlock: '0x1',
    spentAtBlock: null,
    txHash: '0x0',
    parentCommitmentHash: null,
  };
}

describe('selectSwapInputNotes', () => {
  test('consolidates the small notes across labels rather than spending the big one', () => {
    const notes = [
      makeNote(5n, '0xa', 0),
      makeNote(2n, '0xa', 1),
      makeNote(100n, '0xb', 2),
    ];
    const sel = selectSwapInputNotes(notes, 6n);
    expect(sel.covered).toBe(true);
    // 2 + 5 = 7 >= 6 with two notes: the 100 note stays untouched.
    expect(sel.notes.map((n) => BigInt(n.value)).sort((a, b) => (a < b ? -1 : 1))).toEqual([2n, 5n]);
  });

  test('falls back to largest-first when smallest-first cannot cover (codex repro)', () => {
    // [1,1,1,1,1,100] target 100: the five smallest never reach 100, but the
    // single 100 note covers — largest-first must find it.
    const notes = [
      ...Array.from({ length: 5 }, (_, i) => makeNote(1n, '0xa', i)),
      makeNote(100n, '0xa', 5),
    ];
    const sel = selectSwapInputNotes(notes, 100n);
    expect(sel.covered).toBe(true);
    expect(sel.notes).toHaveLength(1);
    expect(sel.total).toBe(100n);
  });

  test('keeps smallest-first consolidation when it covers', () => {
    const notes = [makeNote(2n, '0xa', 0), makeNote(5n, '0xa', 1), makeNote(100n, '0xa', 2)];
    const sel = selectSwapInputNotes(notes, 6n);
    expect(sel.covered).toBe(true);
    // 2 + 5 = 7 ≥ 6: consolidates the small notes instead of spending 100.
    const values = sel.notes.map((n) => BigInt(n.value)).sort((a, b) => (a < b ? -1 : 1));
    expect(values).toEqual([2n, 5n]);
  });

  test('mixes labels inside one proof: two 0.004 deposits cover a 0.005 swap (Pat, prod 2026-09-04)', () => {
    const notes = [makeNote(4n, '0xa', 0), makeNote(4n, '0xb', 1)];
    const sel = selectSwapInputNotes(notes, 5n);
    expect(sel.covered).toBe(true);
    expect(sel.notes).toHaveLength(2);
    expect(sel.total).toBe(8n);
    expect(new Set(sel.notes.map((n) => n.label)).size).toBe(2);
  });

  test('the cap is five inputs in total, not five per label', () => {
    const notes = [
      ...Array.from({ length: 3 }, (_, i) => makeNote(1n, '0xa', i)),
      ...Array.from({ length: 3 }, (_, i) => makeNote(1n, '0xb', 10 + i)),
    ];
    const sel = selectSwapInputNotes(notes, 6n, 5);
    expect(sel.covered).toBe(false);
    expect(sel.notes).toHaveLength(5);
    expect(sel.total).toBe(5n);
  });

  test('respects the input cap', () => {
    const notes = Array.from({ length: 7 }, (_, i) => makeNote(1n, '0xa', i));
    const sel = selectSwapInputNotes(notes, 7n, 5);
    expect(sel.covered).toBe(false);
    expect(sel.notes).toHaveLength(5);
    expect(sel.total).toBe(5n);
  });

  // Two spellings of one address are one token: the vendored SDK accepts them
  // in one proof (v2-monorepo#436), and splitting them left 18.97 of 36.5
  // ppUSDT swappable (Mike, 2026-09-24).
  test('combines token ids that differ only by casing', () => {
    const notes = [
      makeNote(60n, '0xa', 0, '0xAbCd' as `0x${string}`),
      makeNote(50n, '0xa', 1, '0xabcd' as `0x${string}`),
    ];
    const sel = selectSwapInputNotes(notes, 100n);
    expect(sel.covered).toBe(true);
    expect(sel.total).toBe(110n);
    expect(sel.notes).toHaveLength(2);
  });

  test('cannot be configured above the shipped five-input ceiling', () => {
    const notes = Array.from({ length: 7 }, (_, i) => makeNote(1n, '0xa', i));
    const sel = selectSwapInputNotes(notes, 99n, 99);
    expect(sel.notes).toHaveLength(5);
    expect(sel.total).toBe(5n);
  });
});

describe('receipt classification (confirm-phase fail-closed)', () => {
  test('only a literal status === true is success', () => {
    expect(isSuccessfulSwapReceipt({ status: true })).toBe(true);
  });
  test('failed/ambiguous receipts are NOT success', () => {
    expect(isSuccessfulSwapReceipt({ status: false })).toBe(false);
    expect(isSuccessfulSwapReceipt({})).toBe(false);
    expect(isSuccessfulSwapReceipt(null)).toBe(false);
    expect(isSuccessfulSwapReceipt(undefined)).toBe(false);
    // Truthy look-alikes must not pass.
    expect(isSuccessfulSwapReceipt({ status: 'success' })).toBe(false);
    expect(isSuccessfulSwapReceipt({ status: 1 })).toBe(false);
  });
});

describe('error classification', () => {
  test('a 5xx from the quote endpoint is ALSO route-unavailable', () => {
    // Deliberate contract change (2026-08-19). This suite used to pin
    // `{ status: 500 }` as NOT unavailable, on the reasoning that a 500 could be
    // a transient fault worth surfacing rather than a missing route. Two things
    // changed: the testing relayer returns HTTP 500 for EVERY quote type on
    // chain 10 while serving chain 1 normally — a permanent, chain-wide fault,
    // not a blip — and cross-chain destinations are now advertised, so a user on
    // that chain reaches the quote step and got a raw "Internal server error"
    // where "swaps aren't available on this network" belongs. Both codes mean
    // the same thing to someone standing at the quote step, and both land before
    // any signature. Two independent reviewers recommended this.
    expect(isSwapUnavailableError({ name: 'HTTPResponseError', message: 'request failed', status: 500 })).toBe(true);
    expect(isSwapUnavailableError({ message: 'outer', cause: { status: 503 } })).toBe(true);
    expect(isSwapUnavailableError(new Error('HTTP 500: quote failed'))).toBe(true);
  });

  test('recognizes a TYPED HTTP 404 from the swap-quote endpoint', () => {
    expect(isSwapUnavailableError({ name: 'HTTPResponseError', message: 'request failed', status: 404 })).toBe(true);
    expect(isSwapUnavailableError({ name: 'HTTPResponseError', message: 'request failed', statusCode: 404 })).toBe(true);
    expect(isSwapUnavailableError({ message: 'outer', cause: { status: 404 } })).toBe(true);
    expect(isSwapUnavailableError(new Error('HTTP 404: quote route missing'))).toBe(true);
  });

  test('NEVER classifies local/proof errors as route-unavailable', () => {
    expect(isSwapUnavailableError(new Error('leaf not found'))).toBe(false);
    expect(isSwapUnavailableError(new Error('note not found in tree'))).toBe(false);
    expect(isSwapUnavailableError({ message: 'outer', cause: { message: 'route not found' } })).toBe(false);
    expect(isSwapUnavailableError(new Error('insufficient funds'))).toBe(false);
    expect(isSwapUnavailableError(undefined)).toBe(false);
    // A bare 'internal error' with NO status and no http/route context is still
    // not this: only a typed status or a literal code with context qualifies.
    expect(isSwapUnavailableError(new Error('internal error'))).toBe(false);
  });

  test('detects a LiFi no-route failure', () => {
    expect(isNoRouteError({ name: 'SwapQuoteFailed', message: 'NO_QUOTE' })).toBe(true);
    expect(isNoRouteError(new Error('No available quotes for the requested transfer'))).toBe(true);
    expect(isNoRouteError(new Error('fee too high'))).toBe(false);
    // v2-monorepo#480: the SDK's typed no-route refusal at estimate time.
    const unavailable = Object.assign(new Error('No swap route from 0xeeee to 0x0b2c on chain 10: executor route refused'), { name: 'SwapRouteUnavailable' });
    expect(isNoRouteError(unavailable)).toBe(true);
  });
});

describe('the proving window against the relayer TTL it has to live inside', () => {
  test('is 50s, below the relayer default quote_expiration_ms of 60s', () => {
    // 75s refused every commitment the relayer ever issued (measured 59.9s).
    expect(SWAP_PROVING_SAFETY_WINDOW_MS).toBe(50_000);
    expect(SWAP_PROVING_SAFETY_WINDOW_MS).toBeLessThan(60_000);
  });

  test('a fresh 59.9s commitment is usable; one that dwelt 15s on review is not', () => {
    const now = 1_788_000_000_000;
    expect(hasUsableCommitmentLifetime(now + 59_900, now)).toBe(true);
    expect(hasUsableCommitmentLifetime(now + 44_900, now)).toBe(false);
  });
  test('a fresh commitment is judged only on expiry, so a fast device clock does not refuse it', () => {
    const now = 1_788_000_000_000;
    // The same 59.9s quote read by a clock 15s fast: below the window, still live.
    expect(hasUsableCommitmentLifetime(now + 44_900, now)).toBe(false);
    expect(isFreshCommitmentLive(now + 44_900, now)).toBe(true);
    expect(isFreshCommitmentLive(now + 1, now)).toBe(true);
    expect(isFreshCommitmentLive(now, now)).toBe(false);
    expect(isFreshCommitmentLive(undefined, now)).toBe(false);
  });
});

describe('validateRefreshedSwapQuote', () => {
  const reviewed = { feeAmount: '23196', estimatedOutput: '2960385', toChainId: 1 };

  test('an identical re-price is accepted', () => {
    expect(validateRefreshedSwapQuote(reviewed, { ...reviewed })).toEqual([]);
  });

  test('movement in the user’s favour is accepted', () => {
    expect(validateRefreshedSwapQuote(reviewed, { ...reviewed, feeAmount: '20000', estimatedOutput: '2999999' })).toEqual([]);
  });

  test('a fee that rose within 1% passes; beyond it does not', () => {
    expect(validateRefreshedSwapQuote(reviewed, { ...reviewed, feeAmount: '23427' })).toEqual([]);     // +0.996%
    expect(validateRefreshedSwapQuote(reviewed, { ...reviewed, feeAmount: '23429' })).toHaveLength(1); // +1.004%
  });

  test('an output that fell within 1% passes; beyond it does not', () => {
    expect(validateRefreshedSwapQuote(reviewed, { ...reviewed, estimatedOutput: '2930782' })).toEqual([]);     // -1.0%
    expect(validateRefreshedSwapQuote(reviewed, { ...reviewed, estimatedOutput: '2930000' })).toHaveLength(1); // -1.03%
  });

  test('a different destination chain is never a refresh of the same order', () => {
    expect(validateRefreshedSwapQuote(reviewed, { ...reviewed, toChainId: 10 })).toHaveLength(1);
  });

  test('an unreadable amount is a problem, not a pass', () => {
    expect(validateRefreshedSwapQuote(reviewed, { ...reviewed, feeAmount: 'nope' })).toHaveLength(1);
  });

  test('a missing or zero estimated output is a problem, not a pass', () => {
    expect(validateRefreshedSwapQuote(reviewed, { ...reviewed, estimatedOutput: '' })).toHaveLength(1);
    expect(validateRefreshedSwapQuote({ ...reviewed, estimatedOutput: '0' }, { ...reviewed, estimatedOutput: '0' })).toHaveLength(1);
  });

  test('a zero reviewed fee tolerates no rise at all', () => {
    expect(validateRefreshedSwapQuote({ ...reviewed, feeAmount: '0' }, { ...reviewed, feeAmount: '1' })).toHaveLength(1);
  });
});
