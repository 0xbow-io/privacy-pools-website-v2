/**
 * The toast the swap form shows when it resets itself because the network or
 * the account changed while it was open (components/swap-modal-provider.tsx).
 *
 * The reset is right (a review frozen on one network must never confirm on
 * another), but the old red banner read as a failure even when the user caused
 * the change by picking a pool on another network. This says what moved where.
 *
 * PURE: chain names come in through `chainName`, so bun tests can import it.
 */
export type SwapContext = {
  chainId: number;
  sessionChainId: number;
  noteIdentity: string;
};

export function describeSwapContextChange(
  prev: SwapContext,
  next: SwapContext,
  chainName: (chainId: number) => string,
): string {
  const accountToo = prev.noteIdentity !== next.noteIdentity ? ' and the account changed' : '';
  if (prev.chainId !== next.chainId) {
    return `Network changed from ${chainName(prev.chainId)} to ${chainName(next.chainId)}${accountToo}. The swap form was reset.`;
  }
  if (prev.sessionChainId !== next.sessionChainId) {
    return `Your wallet moved from ${chainName(prev.sessionChainId)} to ${chainName(next.sessionChainId)}${accountToo}. The swap form was reset.`;
  }
  return 'Account changed. The swap form was reset.';
}
