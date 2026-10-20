// The Swap tab's "~ what you receive" asks LiFi for an exact-in estimate. A
// yield share (ppUSDC, ppUSDT, ppETH) has no market of its own: the swap
// redeems it to its underlying first and deposits the output back as a share.
// So the preview has to be priced the same way, underlying to underlying, or
// every mainnet pair comes back empty (QA 2026-09-24).
//
// Pure (no config imports) so it is unit-testable; the caller resolves the
// funding tokens (config/intent-targets conversionFundingToken) and the live
// share rate (hooks/use-share-rates).

export type PreviewShareRate = { assetsPerShare: bigint; shareDecimals: number };

/**
 * Underlying units a share amount redeems to. A plain token passes through.
 * Returns null for a share whose rate is not known yet: quoting the share
 * amount as if it were the underlying would print a wrong figure.
 */
export function previewInputAmount(
  amountWei: bigint,
  isShare: boolean,
  rate: PreviewShareRate | undefined,
): bigint | null {
  if (!isShare) return amountWei;
  if (!rate || rate.assetsPerShare <= 0n) return null;
  return (amountWei * rate.assetsPerShare) / 10n ** BigInt(rate.shareDecimals);
}

/**
 * Whether the preview needs LiFi at all. The same funding token on the same
 * chain on both sides is a straight redeem-and-redeposit, so the estimate is
 * the underlying amount itself.
 */
export function previewIsIdentity(
  fromFunding: string,
  toFunding: string,
  fromChainId: number,
  toChainId: number,
): boolean {
  return fromChainId === toChainId && fromFunding.toLowerCase() === toFunding.toLowerCase();
}
