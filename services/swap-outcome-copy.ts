/**
 * What a finished cross-chain swap screen says, by outcome (DEV-434).
 *
 * PURE (no react-native imports) so bun can pin it.
 *
 * The title stayed "Swap submitted" when nothing was deposited, and a REFUNDED
 * outcome (funds back on the SOURCE chain) was described as a payout on the
 * destination chain. LI.FI's substatus says which one happened.
 */

export type SwapDelivery = { status: 'pending' | 'done' | 'recovered' | 'failed'; refunded?: boolean } | null;

/** The success screen's title for this outcome. */
export function swapOutcomeTitle(delivery: SwapDelivery, sourceName: string, submittedTitle: string): string {
  if (delivery?.status === 'recovered') {
    return delivery.refunded ? `Swap refunded on ${sourceName}` : "Swap didn't deposit";
  }
  if (delivery?.status === 'failed') return "Swap didn't complete";
  return submittedTitle;
}

/** Where a recovered swap's funds went: the chain that actually received them. */
export function recoveredWhere(refunded: boolean | undefined, sourceName: string, destinationName: string): string {
  return refunded
    ? `the bridge refunded the amount to your wallet on ${sourceName}`
    : `the bridge paid your address on ${destinationName} instead`;
}

/** LI.FI substatus → refunded to the source chain. */
export function isRefundSubstatus(substatus: string | null | undefined): boolean {
  return (substatus ?? '').toUpperCase() === 'REFUNDED';
}

export type SwapResultTone = 'success' | 'neutral' | 'warning';

/**
 * How the result screen marks this outcome. A fallback payout, refund or
 * failure is not a success, and no destination note exists for it, so the
 * "couldn't record the new note" warning would be false there.
 * `null` delivery = no far leg to wait for (same-chain), the swap is done.
 */
export function swapResultIndicator(delivery: SwapDelivery, noteSyncFailed: boolean): { tone: SwapResultTone; showNoteSyncWarning: boolean } {
  if (delivery?.status === 'recovered' || delivery?.status === 'failed') {
    return { tone: 'warning', showNoteSyncWarning: false };
  }
  return { tone: delivery?.status === 'pending' ? 'neutral' : 'success', showNoteSyncWarning: noteSyncFailed };
}
