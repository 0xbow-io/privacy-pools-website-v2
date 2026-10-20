/**
 * Bounds on the amount a payment request may ask for.
 *
 * Nathaniel, QA 2026-09-21, on a request for 0.000001 ETH showing $0.00 with
 * Create Request live: "should probably have some limits on upper and lower
 * limits of requesting". Both ends were open, and both produce a link that
 * cannot be paid:
 *
 *  - Above: paying a request IS a deposit, so it meets the same per-deposit
 *    cap the Shield path enforces. That cap was already checked at PAY time
 *    (assertDepositCap in the payer path), which is too late: the link has
 *    been sent by then and the payer is the one who hits the wall. Checking it
 *    at CREATE time is the same rule read one step earlier.
 *  - Below: the request is fulfilled by a relayed private transfer, and the
 *    relayer's charge is dominated by a FIXED gas term, not a percentage. Below
 *    that term the fee is more than the money.
 *
 * The cap half deliberately calls straight into services/deposit-cap.ts rather
 * than restating the rule: a second copy of "what may be deposited" drifts from
 * the first, and the first is the one the ASP agrees with.
 *
 * PURE module: price and cap are injected, so both bounds are unit-testable.
 */
import { checkDepositCap } from '@/services/deposit-cap';
import { isStablecoin } from '@/services/token-format';

/**
 * The relayer's fixed charge, in USD, as measured on this project rather than
 * guessed: the relayer charges a fixed gas budget per operation at the current
 * gas price, so the charge barely moves with the amount. Two measurements
 * of the same term agree: one withdraw was 55% of 0.001 ETH and 0.054% of
 * 1 ETH, which at ETH near $2,100 is about $1.15 either way.
 *
 * It is gas-dependent, so it is a floor of the right ORDER, not a constant of
 * nature. When this flow gains a live quote, take the number from the quote.
 */
export const RELAYER_FIXED_FEE_USD = 1.15;

/**
 * Smallest request worth making. Set AT the fee, not at a round number above
 * it: that is exactly the point where the fee stops being more than the
 * amount, which is what the refusal tells the user. Anything under it is a
 * link whose fulfilment costs the payer more than it moves.
 */
export const PAYMENT_REQUEST_MIN_USD = RELAYER_FIXED_FEE_USD;

export type PaymentRequestBoundsVerdict =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'too-small' | 'over' | 'no-price' | 'pending'; message: string };

/** The price the bounds are read at, or null when nothing can price this. */
function priceOf(symbol: string, priceUsd: number | null | undefined): number | null {
  if (priceUsd && Number.isFinite(priceUsd) && priceUsd > 0) return priceUsd;
  return isStablecoin(symbol) ? 1 : null;
}

/**
 * Check one requested amount against both bounds.
 *
 * The FLOOR fails OPEN when nothing can price the asset: refusing to create a
 * request because a price feed blinked would be a worse dead end than the one
 * being fixed, and the floor is a payability heuristic rather than a rule any
 * contract enforces. The CAP keeps deposit-cap.ts's fail-CLOSED stance, because
 * that one the ASP really does enforce and a guess in the user's favour there
 * just moves the refusal to the payer.
 *
 * `capUsd: undefined` is an uncapped environment (staging). The floor still
 * applies there: it is about what can be paid, not about the launch limit.
 */
export function checkPaymentRequestBounds(input: {
  amount: number;
  symbol: string;
  priceUsd: number | null | undefined;
  capUsd: number | undefined;
  pricePending?: boolean;
}): PaymentRequestBoundsVerdict {
  const { amount, symbol, capUsd } = input;
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: 'invalid', message: 'Enter an amount first.' };
  }

  const price = priceOf(symbol, input.priceUsd);
  if (price !== null && amount * price < PAYMENT_REQUEST_MIN_USD) {
    return { ok: false, reason: 'too-small', message: 'Too small to be paid. The fee would be more than the amount.' };
  }

  const cap = checkDepositCap({ amount, symbol, priceUsd: input.priceUsd, capUsd, pricePending: input.pricePending });
  if (cap.ok) return { ok: true };
  // The cap's own wording is written for someone about to deposit. Here the
  // user is about to ask someone ELSE to, so it names the limit on the request.
  if (cap.reason === 'over') {
    return { ok: false, reason: 'over', message: `Requests are capped at $${capUsd} on this network.` };
  }
  return { ok: false, reason: cap.reason, message: cap.message };
}

export class PaymentRequestBoundsError extends Error {
  readonly reason: Exclude<PaymentRequestBoundsVerdict, { ok: true }>['reason'];
  constructor(verdict: Exclude<PaymentRequestBoundsVerdict, { ok: true }>) {
    super(verdict.message);
    this.name = 'PaymentRequestBoundsError';
    this.reason = verdict.reason;
  }
}

/**
 * Async form for the create path, which holds a typed amount and no price.
 * Mirrors assertDepositCap: it fetches a price only when one is needed, so an
 * uncapped environment asking for a stablecoin makes no network call.
 */
export async function assertPaymentRequestBounds(input: {
  amount: number;
  symbol: string;
  capUsd: number | undefined;
  fetchPrice: (symbol: string) => Promise<number>;
}): Promise<void> {
  let priceUsd: number | null = null;
  if (!isStablecoin(input.symbol)) {
    try {
      priceUsd = await input.fetchPrice(input.symbol);
    } catch {
      priceUsd = null; // floor opens, cap closes — see checkPaymentRequestBounds
    }
  }
  const verdict = checkPaymentRequestBounds({
    amount: input.amount,
    symbol: input.symbol,
    priceUsd,
    capUsd: input.capUsd,
  });
  if (!verdict.ok) throw new PaymentRequestBoundsError(verdict);
}
