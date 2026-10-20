// Redeeming a yield-share note (ppUSDC) to its underlying (USDC) on withdrawal,
// through the PPRouter, relayed. The pure decisions live here so they can be
// tested without the modal: whether a relayer quote can back the redemption,
// and whether a relayer failure is a definitive refusal (nothing broadcast, the
// ordinary share-token payout may run instead) or an unknown outcome (nothing
// may run instead).

import { displayTokenSymbol } from '@/services/share-display';
import type { WithdrawalQuote } from '@/hooks/use-relayer';
import { feeWithinReviewed } from '@/services/relayer-fee-jitter';
import { quoteMatchesSignedCommitment } from '@/services/relayer-quote-integrity';
import { isRelayerRefusal } from '@/services/transfer-outcome';

export type YieldRedemptionPlan =
  | {
    /** Total shares paid to the router (recipient leg + fee leg), hex. Also the value released from the pool. */
    amountOutHex: `0x${string}`;
    feeAmount: string;
    feeCommitment: WithdrawalQuote['feeCommitment'];
  }
  | { refusal: string };

/**
 * Turns a relayer quote for the SHARE into the router redemption's sizing, or a
 * refusal. The in-pool fee is 0 on this route: the relayer's fee leg is split
 * from the withdrawn shares by the router, and it is committed in the quote.
 */
export function planYieldRedemption(input: {
  quote: WithdrawalQuote;
  shareToken: string;
  requestedWei: bigint;
  /** The fee the user reviewed for this asset; the relay may not charge more. */
  reviewedFeeWei: bigint;
}): YieldRedemptionPlan {
  const { quote, shareToken, requestedWei, reviewedFeeWei } = input;
  // Every decision reads the SIGNED commitment: the top-level copies are
  // display fields a relayer could misreport (codex, 2026-09-04). They must
  // agree with the signed ones or the quote is refused outright.
  const fc = quote.feeCommitment;
  if (fc.asset.toLowerCase() !== shareToken.toLowerCase()) {
    return { refusal: `the relayer quoted ${fc.asset}, not the share ${shareToken}` };
  }
  let sent: bigint;
  let received: bigint;
  let fee: bigint;
  try {
    sent = BigInt(fc.amountSent);
    received = BigInt(fc.amountReceived);
    fee = BigInt(fc.feeAmount);
    if (!quoteMatchesSignedCommitment(quote)) {
      return { refusal: 'the relayer quote does not match its signed commitment' };
    }
  } catch {
    return { refusal: 'the relayer quote carries non-numeric amounts' };
  }
  // /receive contract: the recipient leg equals the request, the gross that
  // leaves the pool is request + fee. The gross is what the router receives
  // and what the SDK's `amount` / `amountOut` both take on this route.
  if (received <= 0n || received !== requestedWei) {
    return { refusal: `the relayer would deliver ${received} shares, the user asked for ${requestedWei}` };
  }
  if (fee < 0n || sent !== received + fee) {
    return { refusal: `the relayer's gross ${sent} is not recipient ${received} + fee ${fee}` };
  }
  if (!feeWithinReviewed(fee, reviewedFeeWei)) return { refusal: `the relayer fee ${fee} exceeds the reviewed fee ${reviewedFeeWei}` };
  return {
    amountOutHex: `0x${sent.toString(16)}`,
    feeAmount: fc.feeAmount,
    feeCommitment: fc,
  };
}

/**
 * True when the relayer answered and said no (an HTTP 4xx, a simulated revert).
 * Diagnostic only: the withdraw modal does NOT fall back after a relay POST on
 * this signal, because the relayer wraps write failures in the same 4xx and a
 * broadcast can have happened (codex, 2026-09-04). Fallback happens only before
 * the POST (quote, plan, prepare).
 */
export function isDefinitiveRelayerRefusal(message: string): boolean {
  if (/failed to fetch|fetch failed|network|timeout|timed out|ECONN|socket/i.test(message)) return false;
  return /HTTP 4\d\d/i.test(message) || isRelayerRefusal(message);
}

/** "about 9.99 USDC (at least 9.94 USDC)" for the success screen. */
export function describeRedemption(input: { quotedOut: bigint; minOut: bigint; decimals: number; symbol: string }): string {
  const fmt = (wei: bigint) => {
    const s = wei.toString().padStart(input.decimals + 1, '0');
    const whole = s.slice(0, -input.decimals) || '0';
    const frac = s.slice(-input.decimals).slice(0, 2);
    return `${whole}.${frac}`;
  };
  return `about ${fmt(input.quotedOut)} ${displayTokenSymbol(input.symbol)} (at least ${fmt(input.minOut)} ${displayTokenSymbol(input.symbol)})`;
}
