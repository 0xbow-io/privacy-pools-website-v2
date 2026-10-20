import type { ExecuteWithdrawRelayerParams } from '@privacy-pools-v2/sdk';

import { FEE_COMMITMENT_EXPIRED_MESSAGE, isLocalFeeCommitmentExpired } from '@/services/fee-commitment';
import { isFreshCommitmentLive } from '@/services/intent-swaps';
import { feeWithinReviewed } from '@/services/relayer-fee-jitter';
import { quoteMatchesSignedCommitment } from '@/services/relayer-quote-integrity';

const EXPIRED_ON_ARRIVAL_MESSAGE =
  'The relayer quote had already expired when it arrived. Nothing was sent and your balance is unchanged. Check that your device clock is set correctly, then press Try Again.';

/** The quote to relay costs more than the user reviewed; nothing was sent. */
export class RelayFeeIncreasedError extends Error {
  constructor(readonly reviewedFee: bigint, readonly relayFee: bigint) {
    super('The relayer fee went up since you reviewed this withdrawal. Nothing was sent. Review again for a fresh quote.');
    this.name = 'RelayFeeIncreasedError';
  }
}

function validateQuote(option: ExecuteWithdrawRelayerParams, reviewedFee: bigint): string {
  const quote = option.selectedQuote.quote;
  const commitment = quote.feeCommitment;
  if (!commitment || !quoteMatchesSignedCommitment({ ...quote, feeCommitment: commitment })
    || commitment.asset.toLowerCase() !== option.tokenId.toLowerCase()
    || commitment.recipient.toLowerCase() !== option.recipientAddress.toLowerCase()
    || BigInt(commitment.amountReceived) !== BigInt(option.amount)
    || BigInt(commitment.amountSent) !== BigInt(option.amount) + BigInt(commitment.feeAmount)) {
    throw new Error('The relayer quote does not match the requested withdrawal. Nothing was sent. Please try again.');
  }
  if (!feeWithinReviewed(BigInt(commitment.feeAmount), reviewedFee)) {
    throw new RelayFeeIncreasedError(reviewedFee, BigInt(commitment.feeAmount));
  }
  return commitment.feeAmount;
}

/**
 * The relayer simulates the call against aspRegistry.latestASPRoot(), which
 * keeps no history, so a deposit approved while the proof was generated
 * rotates the root and the simulation reverts with PoolVault_InvalidASPRoot.
 * Only a RelayerRejected carries that refusal: a receipt-wait failure that
 * mentions the same contract error may follow a broadcast.
 */
export function isStaleAspRootRejection(error: unknown): boolean {
  return error instanceof Error && error.name === 'RelayerRejected' && /InvalidASPRoot/i.test(error.message);
}

/**
 * Relay a plain withdrawal against a committed quote fetched right before the
 * proof, so the relayer's ~60 s commitment covers one proof, not two.
 * `prepareOption` requests that quote; every quote must match the requested
 * asset, recipient and amounts and stay within the reviewed fee. A stale ASP
 * root gets one retry with a fresh quote, since `relayWithdraw` re-reads and
 * verifies the leaves before it proves. Other failures propagate unchanged.
 */
export async function relayWithdrawalWithFreshQuote<Option extends ExecuteWithdrawRelayerParams, Result>({
  prepareOption, reviewedFee, relay, shouldContinue, onStaleAspRoot, now = Date.now,
}: {
  prepareOption: () => Promise<Option>;
  reviewedFee: bigint;
  relay: (option: Option) => Promise<Result>;
  shouldContinue: () => boolean;
  onStaleAspRoot: (error: Error) => void;
  now?: () => number;
}): Promise<{ result: Result; feeAmount: string } | null> {
  for (let attempt = 0; ; attempt++) {
    if (!shouldContinue()) return null;
    const option = await prepareOption();
    if (!shouldContinue()) return null;
    const feeAmount = validateQuote(option, reviewedFee);
    // No proving window: the quote is seconds old, so a window could only
    // misfire on a device clock running ahead of the relayer's and refuse every
    // withdrawal. Running out mid-proof is caught before the POST by the SDK.
    if (!isFreshCommitmentLive(option.selectedQuote.quote.feeCommitment?.expiration, now())) {
      throw new Error(EXPIRED_ON_ARRIVAL_MESSAGE);
    }
    try {
      const result = await relay(option);
      return { result, feeAmount };
    } catch (error) {
      // Only the SDK's local pre-POST expiry can promise that nothing was sent.
      if (isLocalFeeCommitmentExpired(error)) throw new Error(FEE_COMMITMENT_EXPIRED_MESSAGE);
      if (attempt > 0 || !isStaleAspRootRejection(error)) throw error;
      onStaleAspRoot(error as Error);
    }
  }
}
