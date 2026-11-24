import { tokenUsd } from '@/services/fee-warning';

// The Swap tab's "~ what you receive" asks LiFi for an exact-in estimate. A
// yield share (ppUSDC, ppUSDT, ppETH) has no market of its own: the swap
// redeems it to its underlying first and deposits the output back as a share.
// So the preview has to be priced the same way, underlying to underlying, or
// every mainnet pair comes back empty (QA 2026-09-24).
//
// Pure (no config imports) so it is unit-testable; the caller resolves the
// redeemed input and destination funding tokens, and the live
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

/** Executor exact-input routes reserve 25% of the estimated fee as headroom.
 * The SDK also holds back one underlying base unit after share redemption. */
export function previewReshieldInput(
  gross: bigint, fee: bigint | null, executor: boolean, isShare: boolean, rate: PreviewShareRate | undefined,
): bigint | null {
  if (fee === null) return null;
  const net = gross - fee - (executor ? fee / 4n : 0n);
  if (net <= 0n) return null;
  const redeemed = previewInputAmount(net, isShare, rate);
  return redeemed !== null && executor && isShare ? redeemed - 1n : redeemed;
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

/** Preview outputs are funding-token units, even when the destination is a share pool. */
export function previewOutputUsd(amountWei: bigint, underlyingDecimals: number, underlyingUsd: number | null): number | null {
  return tokenUsd(amountWei, underlyingDecimals, underlyingUsd);
}

/** A yield exit redeems ERC-20 underlying even when its deposit router takes native coin. */
export function redeemedSwapInputToken(address: string, deployment?: { underlying: string }): string {
  return deployment?.underlying ?? address;
}
