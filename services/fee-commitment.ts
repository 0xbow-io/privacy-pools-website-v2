/**
 * Display copy for any flow whose fee commitment expired before sending. Two
 * checks produce that error, and both run before anything is submitted: the
 * SDK's local check before the relay POST, and the relayer's own check (an
 * HTTP 400 RelayerRejected) before it broadcasts. So nothing was sent.
 */
export const FEE_COMMITMENT_EXPIRED_MESSAGE =
  'The relayer quote ran out before the transaction could be sent. Nothing was sent and your balance is unchanged. Press Try Again for a fresh quote.';

/** Only the SDK's named local failure establishes expiry before the relay POST. */
export function isLocalFeeCommitmentExpired(error: unknown): boolean {
  return error instanceof Error && error.name === 'FeeCommitmentExpired';
}

/**
 * Recognize the error itself, never diagnostic mentions or a nested cause that
 * could mask a later receipt/transport failure. Text-only boundaries accept the
 * SDK's complete message shape, and other named error types remain authoritative.
 */
export function isFeeCommitmentExpired(error: unknown): boolean {
  const messageShape = /^Fee commitment expired at \d+, current time \d+$/;
  if (typeof error === 'string') return messageShape.test(error);
  if (!error || typeof error !== 'object') return false;
  const value = error as { name?: unknown; message?: unknown };
  if (value.name === 'FeeCommitmentExpired') return true;
  // The relayer's own check against its clock, which runs before it submits
  // anything (BadRequestException in its fee-commitment verification).
  if (value.name === 'RelayerRejected') {
    return typeof value.message === 'string'
      && /^HTTP 400\b.*"message"\s*:\s*"(?:Batch fee|Fee) commitment has expired"/s.test(value.message);
  }
  if (value.name !== undefined && value.name !== 'Error') return false;
  return typeof value.message === 'string' && messageShape.test(value.message);
}
