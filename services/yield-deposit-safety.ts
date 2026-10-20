// Pure safety rules for the app-side yield deposit boundary.
//
// The SDK binds the caller-supplied maxUnderlyingIn into
// depositExactShares (PR #398); the
// payer's exact router allowance is the second invariant that prevents a
// deposit from pulling more underlying than the amount reviewed in the app.

export type PreparedYieldDepositSafetyInput = {
  depositTx: { to: string };
  underlyingNeeded: bigint;
  maxUnderlyingIn: bigint;
};

export function validatePreparedYieldDeposit(
  prepared: PreparedYieldDepositSafetyInput,
  reviewedAmount: bigint,
  expectedRouter: string,
): { approvalCap: bigint } {
  if (prepared.depositTx.to.toLowerCase() !== expectedRouter.toLowerCase()) {
    throw new Error(
      'The prepared yield deposit targets a different router than the verified deployment. Nothing was signed or sent. Refresh and try again.',
    );
  }
  if (prepared.underlyingNeeded > reviewedAmount) {
    throw new Error(
      'The yield vault now needs more than the amount you reviewed. Nothing was signed or sent. Review the deposit again.',
    );
  }

  const approvalCap = prepared.maxUnderlyingIn < reviewedAmount
    ? prepared.maxUnderlyingIn
    : reviewedAmount;
  if (approvalCap < prepared.underlyingNeeded) {
    throw new Error(
      'The prepared yield deposit has an invalid spend limit. Nothing was signed or sent. Refresh and try again.',
    );
  }
  return { approvalCap };
}

/** Values to approve, in order, before the deposit may be signed. */
export function yieldApprovalValues(
  currentAllowance: bigint,
  approvalCap: bigint,
  tokenSymbol: string,
): bigint[] {
  if (currentAllowance === approvalCap) return [];
  // Tether-style tokens reject approve(non-zero) while a non-zero allowance
  // exists. Clear first whether we are raising or lowering the allowance.
  if (currentAllowance !== 0n && tokenSymbol.toUpperCase() === 'USDT') {
    return [0n, approvalCap];
  }
  return [approvalCap];
}

/** A direct non-zero-to-non-zero approval may be retried via approve(0). */
export function approvalErrorAllowsZeroReset(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/user (rejected|denied|cancelled)|rejected by user|request rejected|cancelled by user/i.test(message)) {
    return false;
  }
  return /revert|execution reverted|non[- ]?zero|allowance|approve/i.test(message);
}

/**
 * The share is never named to the user (services/share-display.ts): the
 * holding reads as the coin it earns on.
 */
export function yieldExitDisclosure(underlyingSymbol: string): string {
  return `You will hold ${underlyingSymbol} in the yield pool. Withdrawing pays out ${underlyingSymbol} plus the yield earned, redeemed at the vault.`;
}

/**
 * Rate headroom for a WRAP, in parts per million. Between the quote and the
 * execution of an exact-shares deposit only two things move the underlying
 * price of the shares: Aave interest accrual (≈1e-9 of the rate per block) and
 * integer rounding. 1 ppm covers ~17 minutes of accrual at 3% APY (Ameen picked
 * it, 2026-09-05); the floor of one underlying unit covers rounding. This is NOT
 * DEX slippage:
 * there is no counterparty and no price impact (Pat, 2026-09-05).
 */
export const WRAP_RATE_HEADROOM_PPM = 1n;

/**
 * The zap supplies this many extra underlying units to Aave on every deposit as a rounding
 * buffer (PPYieldTokenZap._SUPPLY_ROUNDING_BUFFER), and the router quote includes them. A cap
 * sized from the BUDGET rather than the quote must add them (codex on d994b09).
 */
export const ZAP_SUPPLY_BUFFER_UNITS = 2n;

/**
 * Size an exact-shares yield deposit from an underlying budget.
 *
 * The SDK's `sharesForUnderlying` knocked 0.5% off the shares as a slippage
 * cushion; since the shares are the fixed leg (they are inside the proof) that
 * cushion became a 0.5% under-deposit: 100 USDC bought 99.49 ppUSDC and 0.50
 * USDC stayed in the wallet (Ameen + Pat, 2026-09-05, mainnet). Here the shares
 * are `previewDeposit(budget)` EXACTLY and the headroom lives in the spend cap
 * instead: the pull may exceed the budget by at most WRAP_RATE_HEADROOM_PPM.
 * When the wallet cannot cover that headroom (a Max deposit) the cap stays at
 * the budget and the SHARES shave by the same ppm, so the pull never exceeds
 * what the wallet holds. Linear scaling is exact for a wrap.
 */
export function sizeWrapDeposit(input: {
  /** Underlying the user typed, in underlying units. */
  underlying: bigint;
  /** Underlying the wallet holds, in underlying units. */
  walletBalance: bigint;
  /** The vault's previewDeposit(underlying): shares for exactly that budget. */
  previewShares: bigint;
  /**
   * Entrypoint vetting fee in bps (0 on prod). The router pulls the underlying for
   * value + fee shares, so the committed shares shrink by 10000/(10000 + fee) to keep
   * the pull inside the budget (the fee is paid out of the typed amount).
   */
  vettingFeeBps?: bigint;
}): { shares: bigint; spendCap: bigint } {
  const { underlying, walletBalance, previewShares } = input;
  const feeBps = input.vettingFeeBps ?? 0n;
  if (underlying <= 0n || previewShares <= 0n || feeBps < 0n) {
    throw new Error('A yield deposit needs a positive amount.');
  }
  const ceilHeadroom = (underlying * WRAP_RATE_HEADROOM_PPM + 999_999n) / 1_000_000n;
  const headroom = ZAP_SUPPLY_BUFFER_UNITS + (ceilHeadroom > 0n ? ceilHeadroom : 1n);
  const withFee = (shares: bigint) => (shares * 10_000n) / (10_000n + feeBps);
  const desiredCap = underlying + headroom;
  const sized = desiredCap <= walletBalance
    ? { shares: withFee(previewShares), spendCap: desiredCap }
    : (() => {
      // The wallet cannot cover the headroom (a Max deposit): the cap stays at
      // the budget and the SHARES shave by the same headroom instead. Linear
      // scaling is exact for a wrap.
      const budget = underlying <= walletBalance ? underlying : walletBalance;
      if (budget <= headroom) throw new Error('A yield deposit needs a positive amount.');
      return { shares: withFee((previewShares * (budget - headroom)) / underlying), spendCap: budget };
    })();
  if (sized.shares <= 0n) throw new Error('A yield deposit needs a positive amount.');
  return sized;
}

/**
 * What the user reads when an exact-shares deposit outlived its quote: the
 * vault rate ticked past the 1 ppm headroom while the wallet prompt waited
 * (Ameen, 2026-09-05: "your deposit tx has expired, please try again").
 */
export const YIELD_QUOTE_EXPIRED_MESSAGE = 'Your deposit has expired: the vault rate moved while it waited. Please try again.';

/**
 * True when a yield deposit failed BECAUSE the quote expired: the router's own
 * PPRouter_SlippageExceeded, or the underlying pull exceeding the exact
 * allowance the app set (the exact allowance is the second bound beside the caller-supplied
 * calldata cap; an older SDK build that ignores the cap still reverts on it). Anything else
 * (user rejection, gas, RPC) is left alone.
 */
export function isExpiredYieldQuoteError(error: unknown): boolean {
  const text = error instanceof Error
    ? `${error.name} ${error.message} ${String((error as { shortMessage?: string }).shortMessage ?? '')} ${String((error as { details?: string }).details ?? '')}`
    : String(error ?? '');
  return /PPRouter_SlippageExceeded|ERC20InsufficientAllowance|exceeds allowance|insufficient allowance/i.test(text);
}

/**
 * True when the SDK refused to prepare the deposit because its quote, taken after proof
 * generation, had already outgrown the cap sized from the earlier previewDeposit: the rate
 * moved while the proof was built. The SDK reports it as InvalidYieldAmount with this exact
 * shape; other InvalidYieldAmount messages (malformed or non-positive share values) are not
 * an expiry and must keep their own wording (codex on a08c7e3).
 */
export function isCapBelowQuoteError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'InvalidYieldAmount') return false;
  return /maxUnderlyingIn \d+ is below the quoted underlyingNeeded \d+/.test(error.message);
}
