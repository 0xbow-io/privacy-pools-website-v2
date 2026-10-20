/**
 * Whether a parked cross-chain deposit may relaunch now.
 *
 * After registering on the far chain the deposit relaunches from its own
 * launch inputs, but only when nothing has superseded it (the launch
 * generation is still the one parked), the app AND the wallet are back on the
 * chain the deposit is sent from, the session keys are ready and the token
 * list has loaded. Any one missing waits for the next render (review of #126).
 *
 * PURE module (no react-native imports) so it is bun-testable.
 */
export type ParkedRelaunch = { chainId: number; gen: number };

export function relaunchReady(p: {
  pending: ParkedRelaunch | null;
  currentGen: number;
  chainId: number;
  walletChainId: number | undefined;
  keysReady: boolean;
  tokenCount: number;
}): boolean {
  if (!p.pending || p.pending.gen !== p.currentGen) return false;
  if (p.chainId !== p.pending.chainId || p.walletChainId !== p.pending.chainId) return false;
  return p.keysReady && p.tokenCount > 0;
}
