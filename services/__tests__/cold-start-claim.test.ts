import { describe, expect, test } from 'bun:test';

import {
  buildRegistrationDeadline,
  convergeFeeOnlyQuote,
  decideRegistrationPath,
  FEE_ONLY_PAYOUT_FLOOR_HEADROOM_BPS,
  feeOnlyQuoteFits,
  parsePayoutFloorWei,
  isAmountRejection,
  planFeeOnlyClaim,
  readRegistrationPath,
  REGISTRATION_DEADLINE_TTL_SECONDS,
  REGISTRATION_GAS_LIMIT,
} from '@/services/cold-start-claim';

describe('decideRegistrationPath', () => {
  test('an unsupported chain always keeps the self-funded path', () => {
    expect(decideRegistrationPath({ supported: false, balanceWei: 0n })).toEqual({
      path: 'self-register',
      reason: 'unsupported',
      estimatedGasCostWei: 0n,
    });
  });

  test('an empty wallet takes the relayed claim without needing a gas price', () => {
    const decision = decideRegistrationPath({ supported: true, balanceWei: 0n });
    expect(decision.path).toBe('relayed-claim');
    expect(decision.reason).toBe('zero-balance');
  });

  test('a balance below the estimate + headroom takes the relayed claim', () => {
    const gasPriceWei = 1_000_000n;
    const bare = REGISTRATION_GAS_LIMIT * gasPriceWei;
    const decision = decideRegistrationPath({ supported: true, balanceWei: bare, gasPriceWei });
    // `bare` covers gasLimit × gasPrice exactly but not the 20% headroom.
    expect(decision.path).toBe('relayed-claim');
    expect(decision.reason).toBe('insufficient-balance');
    expect(decision.estimatedGasCostWei).toBeGreaterThan(bare);
  });

  test('a funded wallet keeps paying its own registration gas', () => {
    const gasPriceWei = 1_000_000n;
    const plenty = REGISTRATION_GAS_LIMIT * gasPriceWei * 10n;
    const decision = decideRegistrationPath({ supported: true, balanceWei: plenty, gasPriceWei });
    expect(decision.path).toBe('self-register');
    expect(decision.reason).toBe('funded');
  });

  test('a non-zero balance with an unreadable gas price stays on the old path', () => {
    const decision = decideRegistrationPath({ supported: true, balanceWei: 1n, gasPriceWei: 0n });
    expect(decision.path).toBe('self-register');
    expect(decision.reason).toBe('unknown-gas-price');
  });
});

describe('buildRegistrationDeadline', () => {
  test('is unix SECONDS as 0x hex, not milliseconds', () => {
    const nowMs = 1_800_000_000_000;
    expect(buildRegistrationDeadline(nowMs, 900)).toBe(
      `0x${(1_800_000_000 + 900).toString(16)}`,
    );
  });

  test('the default TTL outlives proof generation plus the relayer round trip', () => {
    // Proving is ~15-30s and the relay round trip adds inclusion latency; a TTL
    // under a couple of minutes would expire a signature the user already gave.
    expect(REGISTRATION_DEADLINE_TTL_SECONDS).toBeGreaterThanOrEqual(300);
  });
});

describe('planFeeOnlyClaim', () => {
  const NOTE = 900_000_000_000_000n; // 0.0009 ETH

  test('at the fixed point the fee is the only value leaving the pool', () => {
    const fee = 1_000_000_000_000n;
    const plan = planFeeOnlyClaim({ noteValueWei: NOTE, amountSentWei: fee, feeAmountWei: fee });
    expect(plan).toEqual({
      grossWei: fee,
      payoutWei: 0n,
      changeWei: NOTE - fee,
      feeOnly: true,
    });
  });

  test('an unconverged quote leaves a dust payout rather than failing', () => {
    // Every downstream assertion only needs amountSent === payout + fee, so a
    // quote that has not reached the fixed point is still submittable.
    const plan = planFeeOnlyClaim({
      noteValueWei: NOTE,
      amountSentWei: 1_000_000_000_100n,
      feeAmountWei: 1_000_000_000_000n,
    });
    expect(plan.payoutWei).toBe(100n);
    expect(plan.feeOnly).toBe(false);
    expect(plan.grossWei).toBe(plan.payoutWei + 1_000_000_000_000n);
    expect(plan.changeWei).toBe(NOTE - plan.grossWei);
  });

  test('the change note keeps everything the fee did not take', () => {
    const plan = planFeeOnlyClaim({
      noteValueWei: NOTE,
      amountSentWei: 5_000n,
      feeAmountWei: 5_000n,
    });
    expect(plan.changeWei + plan.grossWei).toBe(NOTE);
  });

  test('rejects a zero fee — the relayer refuses amountOut == 0', () => {
    expect(() => planFeeOnlyClaim({ noteValueWei: NOTE, amountSentWei: 0n, feeAmountWei: 0n }))
      .toThrow(/quoted no fee/);
  });

  test('rejects a gross below the quoted fee', () => {
    expect(() => planFeeOnlyClaim({ noteValueWei: NOTE, amountSentWei: 10n, feeAmountWei: 20n }))
      .toThrow(/less than its own fee|inconsistent/);
  });

  test('rejects a fee the note cannot cover', () => {
    expect(() => planFeeOnlyClaim({
      noteValueWei: NOTE,
      amountSentWei: NOTE + 1n,
      feeAmountWei: NOTE + 1n,
    })).toThrow(/exceeds this payment/);
  });

  test('rejects a fee that would consume the whole note', () => {
    expect(() => planFeeOnlyClaim({ noteValueWei: NOTE, amountSentWei: NOTE, feeAmountWei: NOTE }))
      .toThrow(/nothing left to claim/);
  });
});

describe('readRegistrationPath', () => {
  const GAS_PRICE = 1_000_000n;
  const FUNDED = REGISTRATION_GAS_LIMIT * GAS_PRICE * 10n;

  test('a funded wallet keeps the self-funded path', async () => {
    const decision = await readRegistrationPath({
      getBalanceWei: async () => FUNDED,
      getGasPriceWei: async () => GAS_PRICE,
    });
    expect(decision.path).toBe('self-register');
    expect(decision.reason).toBe('funded');
    expect(decision.balanceWei).toBe(FUNDED);
  });

  test('an empty wallet takes the relayed claim', async () => {
    const decision = await readRegistrationPath({
      getBalanceWei: async () => 0n,
      getGasPriceWei: async () => GAS_PRICE,
    });
    expect(decision.path).toBe('relayed-claim');
    expect(decision.reason).toBe('zero-balance');
  });

  test('a FAILED balance read never reads as an empty wallet', async () => {
    // The regression this exists for: `balanceWei = 0n` as an initial value made
    // a transient eth_getBalance failure indistinguishable from a genuinely
    // empty wallet, handing a FUNDED user to the relayer and moving the fee onto
    // the note they were claiming.
    const scopes: string[] = [];
    const decision = await readRegistrationPath({
      getBalanceWei: async () => { throw new Error('RPC down'); },
      getGasPriceWei: async () => GAS_PRICE,
    }, { onReadError: (scope) => scopes.push(scope) });
    expect(decision.path).toBe('self-register');
    expect(decision.reason).toBe('balance-unreadable');
    expect(scopes).toContain('balance');
  });

  test('a failed gas-price read alone still honours a genuinely zero balance', async () => {
    const decision = await readRegistrationPath({
      getBalanceWei: async () => 0n,
      getGasPriceWei: async () => { throw new Error('RPC down'); },
    });
    expect(decision.path).toBe('relayed-claim');
    expect(decision.reason).toBe('zero-balance');
    expect(decision.gasPriceWei).toBeUndefined();
  });

  test('a failed gas-price read with a non-zero balance stays conservative', async () => {
    const decision = await readRegistrationPath({
      getBalanceWei: async () => 1n,
      getGasPriceWei: async () => { throw new Error('RPC down'); },
    });
    expect(decision.path).toBe('self-register');
    expect(decision.reason).toBe('unknown-gas-price');
  });

  test('an unsupported chain is forced onto the self-funded path', async () => {
    const decision = await readRegistrationPath({
      getBalanceWei: async () => 0n,
      getGasPriceWei: async () => GAS_PRICE,
    }, { supported: false });
    expect(decision.path).toBe('self-register');
    expect(decision.reason).toBe('unsupported');
  });
});

describe('convergeFeeOnlyQuote', () => {
  // The real /receive quote: `amount` is the PAYOUT, amountSent = amount + fee.
  // With extraGas the relayer refuses a payout below its native gas floor.
  const relayer = (fee: bigint, floor?: bigint) => {
    const asks: bigint[] = [];
    const quoteFor = async (amountWei: bigint) => {
      asks.push(amountWei);
      if (floor !== undefined && amountWei < floor) {
        throw new Error(`Native gas cost (${floor} token units) exceeds amount received (${amountWei}). Increase the withdrawal amount.`);
      }
      return { amountSent: (amountWei + fee).toString(), feeAmount: fee.toString() };
    };
    return { asks, quoteFor };
  };

  test('asks for a zero payout so only the fee leaves the pool (DEV-482)', async () => {
    const { asks, quoteFor } = relayer(100n);
    const initialQuote = await quoteFor(10_000n);
    const { quote, tightened } = await convergeFeeOnlyQuote({ initialQuote, quoteFor });
    expect(tightened).toBe(true);
    expect(asks).toEqual([10_000n, 0n]);
    expect(quote.amountSent).toBe('100');
    expect(quote.feeAmount).toBe('100');
  });

  test('never pays the fee out a second time (the DEV-482 double withdrawal)', async () => {
    const { quoteFor } = relayer(3_163n);
    const { quote } = await convergeFeeOnlyQuote({ initialQuote: await quoteFor(12_000n), quoteFor });
    expect(BigInt(quote.amountSent) - BigInt(quote.feeAmount)).toBe(0n);
  });

  test('with a top-up, re-asks at the relayer floor plus headroom', async () => {
    const { asks, quoteFor } = relayer(800n, 284n);
    const refusals: unknown[] = [];
    const { quote, tightened } = await convergeFeeOnlyQuote({
      initialQuote: await quoteFor(10_000n),
      quoteFor,
      onRefused: (err) => refusals.push(err),
    });
    expect(tightened).toBe(true);
    expect(refusals).toHaveLength(1);
    expect(asks).toEqual([10_000n, 0n, 284n + (284n * FEE_ONLY_PAYOUT_FLOOR_HEADROOM_BPS) / 10_000n]);
    expect(BigInt(quote.amountSent) - 800n).toBeLessThan(800n);
  });

  test('a quote already at the fixed point is left alone and never re-quoted', async () => {
    let calls = 0;
    const { quote, tightened } = await convergeFeeOnlyQuote({
      initialQuote: { amountSent: '100', feeAmount: '100' },
      quoteFor: async () => { calls++; return { amountSent: '100', feeAmount: '100' }; },
    });
    expect(calls).toBe(0);
    expect(tightened).toBe(false);
    expect(quote.amountSent).toBe('100');
  });

  test('an unexplained refusal keeps the quote in hand and reports no tightening', async () => {
    const refusals: unknown[] = [];
    const { quote, tightened } = await convergeFeeOnlyQuote({
      initialQuote: { amountSent: '10100', feeAmount: '100' },
      quoteFor: async () => { throw new Error('Relay fee exceeds withdrawal amount'); },
      onRefused: (err) => refusals.push(err),
    });
    expect(refusals).toHaveLength(1);
    expect(tightened).toBe(false);
    expect(quote.amountSent).toBe('10100');
  });

  test('a re-quote that does not shrink the gross is not taken', async () => {
    const { tightened } = await convergeFeeOnlyQuote({
      initialQuote: { amountSent: '10100', feeAmount: '100' },
      quoteFor: async () => ({ amountSent: '20000', feeAmount: '100' }),
    });
    expect(tightened).toBe(false);
  });

  test('the pass count is bounded when the floor keeps rising', async () => {
    let calls = 0;
    let floor = 100n;
    await convergeFeeOnlyQuote({
      initialQuote: { amountSent: '1000000', feeAmount: '1000' },
      quoteFor: async (amountWei) => {
        calls++;
        floor *= 2n;
        throw new Error(`Native gas cost (${floor} token units) exceeds amount received (${amountWei})`);
      },
      attempts: 4,
    });
    expect(calls).toBe(3);
  });
});

describe('feeOnlyQuoteFits (DEV-482 top-up decision)', () => {
  // Real /receive shape with an extraGas payout floor N.
  const relayer = (fee: bigint, floor?: bigint) => async (amountWei: bigint) => {
    if (floor !== undefined && amountWei < floor) {
      throw new Error(`Native gas cost (${floor} token units) exceeds amount received (${amountWei}). Increase the withdrawal amount.`);
    }
    return { amountSent: (amountWei + fee).toString(), feeAmount: fee.toString() };
  };

  test('small Ethereum claim: V >= N passes the full-value quote but F + 1.25N > V does not fit', async () => {
    const V = 1_000n; const F = 700n; const N = 284n; // F + 1.25N = 1055 > V
    const withTopUp = relayer(F, N);
    const initial = await withTopUp(V); // accepted: V >= N
    const converged = await convergeFeeOnlyQuote({ initialQuote: initial, quoteFor: withTopUp });
    expect(converged.tightened).toBe(true);
    expect(BigInt(converged.quote.amountSent)).toBeGreaterThan(V);
    expect(feeOnlyQuoteFits(converged, V)).toBe(false);
    // The fallback without the top-up fits, so the claim goes ahead.
    const plain = relayer(500n);
    const fallback = await convergeFeeOnlyQuote({ initialQuote: await plain(V), quoteFor: plain });
    expect(feeOnlyQuoteFits(fallback, V)).toBe(true);
  });

  test('a top-up payout that fits is subtracted from what stays shielded', async () => {
    const V = 10_000n; const F = 800n; const N = 284n;
    const quoteFor = relayer(F, N);
    const converged = await convergeFeeOnlyQuote({ initialQuote: await quoteFor(V), quoteFor });
    expect(feeOnlyQuoteFits(converged, V)).toBe(true);
    const plan = planFeeOnlyClaim({
      noteValueWei: V,
      amountSentWei: BigInt(converged.quote.amountSent),
      feeAmountWei: BigInt(converged.quote.feeAmount),
    });
    const payout = N + (N * FEE_ONLY_PAYOUT_FLOOR_HEADROOM_BPS) / 10_000n;
    expect(plan.payoutWei).toBe(payout);
    expect(plan.changeWei).toBe(V - F - payout);
  });

  test('a zero-fee quote never fits', () => {
    expect(feeOnlyQuoteFits({ quote: { amountSent: '0', feeAmount: '0' }, tightened: false }, 20_000n)).toBe(false);
  });

  test('an untightened full-value quote never fits', () => {
    expect(feeOnlyQuoteFits({ quote: { amountSent: '10100', feeAmount: '100' }, tightened: false }, 20_000n)).toBe(false);
  });
});

describe('parsePayoutFloorWei', () => {
  test('reads the floor from the relayer refusal and nothing else', () => {
    expect(parsePayoutFloorWei(new Error('Native gas cost (322590921642725092 token units) exceeds amount received (1). Increase the withdrawal amount.')))
      .toBe(322590921642725092n);
    expect(parsePayoutFloorWei(new Error('Relay fee (5) exceeds withdrawal amount (1)'))).toBeNull();
  });
});

describe('isAmountRejection', () => {
  test('recognises the relayer’s "this amount is not worth relaying" family', () => {
    expect(isAmountRejection(new Error('Relay fee (500) exceeds withdrawal amount (100)'))).toBe(true);
    expect(isAmountRejection(new Error('asset not relayable'))).toBe(true);
    expect(isAmountRejection(new Error('amount is below the relay cost'))).toBe(true);
  });

  test('an outage is NOT an answer about the amount', () => {
    expect(isAmountRejection(new Error('fetch failed'))).toBe(false);
    expect(isAmountRejection(new Error('502 Bad Gateway'))).toBe(false);
    expect(isAmountRejection(new Error('The operation timed out'))).toBe(false);
    expect(isAmountRejection(undefined)).toBe(false);
  });
});
