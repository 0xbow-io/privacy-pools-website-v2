import { describe, expect, test } from 'bun:test';
import {
  PAYMENT_REQUEST_MIN_USD,
  PaymentRequestBoundsError,
  assertPaymentRequestBounds,
  checkPaymentRequestBounds,
} from '@/services/payment-request-bounds';

// Prod's per-deposit cap. Staging leaves maxDepositUsd undefined, i.e. uncapped.
const CAP = 100;
const ETH = 2100;

// No default parameter for the cap: JS defaults fire on an explicit
// `undefined`, which is the exact value "uncapped" is spelled with, so a
// default here would quietly run every uncapped case against the cap.
const usdc = (amount: number, capUsd: number | undefined) =>
  checkPaymentRequestBounds({ amount, symbol: 'USDC', priceUsd: null, capUsd });
const eth = (amount: number, capUsd: number | undefined) =>
  checkPaymentRequestBounds({ amount, symbol: 'ETH', priceUsd: ETH, capUsd });

describe('the upper bound is the deposit cap, read one step earlier', () => {
  test('exactly at the cap is allowed, and one cent over is not', () => {
    expect(usdc(CAP, CAP)).toEqual({ ok: true });
    const over = usdc(CAP + 0.01, CAP);
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.reason).toBe('over');
  });

  test('the refusal names the limit and what it applies to, not "invalid amount"', () => {
    const over = usdc(500, CAP);
    expect(over.ok === false && over.message).toBe('Requests are capped at $100 on this network.');
    // House rule: no em dashes in user-facing copy.
    expect(over.ok === false && over.message).not.toContain('—');
  });

  test('the cap is priced, so it binds a non-stablecoin at its own rate', () => {
    // $100 / $2,100 is about 0.0476 ETH.
    expect(eth(0.047, CAP)).toEqual({ ok: true });
    const over = eth(0.05, CAP);
    expect(over.ok === false && over.reason).toBe('over');
  });
});

describe('the lower bound is the relayer fee, which is a fixed gas term', () => {
  test('an amount worth less than the fee is refused, and told why', () => {
    const tiny = eth(0.000001, CAP); // Nathaniel's screenshot: reads $0.00
    expect(tiny.ok).toBe(false);
    expect(tiny.ok === false && tiny.reason).toBe('too-small');
    expect(tiny.ok === false && tiny.message).toBe('Too small to be paid. The fee would be more than the amount.');
    expect(tiny.ok === false && tiny.message).not.toContain('—');
  });

  test('the floor sits AT the fee, so the first payable amount passes', () => {
    expect(usdc(PAYMENT_REQUEST_MIN_USD, CAP)).toEqual({ ok: true });
    const under = usdc(PAYMENT_REQUEST_MIN_USD - 0.01, CAP);
    expect(under.ok === false && under.reason).toBe('too-small');
  });

  test('zero and nonsense are refused before either bound is consulted', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const v = checkPaymentRequestBounds({ amount: bad, symbol: 'USDC', priceUsd: null, capUsd: CAP });
      expect(v.ok === false && v.reason).toBe('invalid');
    }
  });
});

describe('an uncapped environment still has a floor', () => {
  test('no cap means no upper bound at all, at any size', () => {
    expect(usdc(1_000_000, undefined)).toEqual({ ok: true });
    expect(eth(1_000, undefined)).toEqual({ ok: true });
  });

  test('but the fee does not go away, so the floor still applies', () => {
    const tiny = eth(0.000001, undefined);
    expect(tiny.ok === false && tiny.reason).toBe('too-small');
  });
});

describe('a missing price', () => {
  test('closes the cap (the ASP enforces it) and opens the floor (a heuristic)', () => {
    const v = checkPaymentRequestBounds({ amount: 5, symbol: 'WBTC', priceUsd: null, capUsd: CAP });
    // Not 'too-small': an unpriceable asset must not be refused as dust.
    expect(v.ok === false && v.reason).toBe('no-price');
  });

  test('with no cap configured there is nothing to fail closed about', () => {
    expect(checkPaymentRequestBounds({ amount: 5, symbol: 'WBTC', priceUsd: null, capUsd: undefined })).toEqual({ ok: true });
  });
});

describe('the async form used by the create path', () => {
  const price = async () => ETH;

  test('a request inside both bounds creates normally', async () => {
    expect(await assertPaymentRequestBounds({ amount: 0.01, symbol: 'ETH', capUsd: CAP, fetchPrice: price })).toBeUndefined();
  });

  test('an out-of-bounds request throws, carrying the reason the toast shows', async () => {
    let thrown: unknown;
    await assertPaymentRequestBounds({ amount: 1, symbol: 'ETH', capUsd: CAP, fetchPrice: price }).catch((e: unknown) => { thrown = e; });
    expect(thrown).toBeInstanceOf(PaymentRequestBoundsError);
    expect((thrown as PaymentRequestBoundsError).reason).toBe('over');
    expect((thrown as PaymentRequestBoundsError).message).toBe('Requests are capped at $100 on this network.');
  });

  test('a stablecoin never asks the price service for a rate', async () => {
    let asked = 0;
    await assertPaymentRequestBounds({
      amount: 50,
      symbol: 'USDC',
      capUsd: CAP,
      fetchPrice: async () => { asked += 1; return 1; },
    });
    expect(asked).toBe(0);
  });

  test('a price service that throws still refuses an over-cap non-stablecoin', async () => {
    let thrown: unknown;
    await assertPaymentRequestBounds({
      amount: 5,
      symbol: 'WBTC',
      capUsd: CAP,
      fetchPrice: async () => { throw new Error('feed down'); },
    }).catch((e: unknown) => { thrown = e; });
    expect(thrown).toBeInstanceOf(PaymentRequestBoundsError);
    expect((thrown as PaymentRequestBoundsError).reason).toBe('no-price');
  });
});
