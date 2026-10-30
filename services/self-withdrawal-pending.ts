// Pure rules for an own-wallet ("self") withdrawal once its transaction has been
// broadcast. Node-testable: no wagmi, no storage.
//
// The danger this closes: the wallet broadcast the transaction, then the receipt
// wait failed (timeout, RPC hiccup). Treating that like a failed withdrawal puts
// the form back with the inputs still ACTIVE, and the next Confirm proves the
// same notes again and posts a second transaction that reverts on the spent
// nullifier, losing gas while the first may well have landed. Once a hash exists
// the only honest states are confirmed, reverted, or "sent, not confirmed yet",
// and the last one is never retryable.

/** The pending-relay record method for a wallet-sent withdrawal. */
export const SELF_WITHDRAW_METHOD = 'selfWithdraw';

export type DirectReceiptOutcome =
  | { kind: 'confirmed'; blockNumber: bigint }
  | { kind: 'reverted' }
  | { kind: 'sent-unconfirmed' };

/**
 * What a receipt lookup means. `failed` is any throw or a missing client: the
 * transaction may still land, so it is never read as a revert.
 */
export function classifyDirectReceipt(
  receipt: { status: 'success' | 'reverted'; blockNumber: bigint } | null | undefined,
  failed: boolean,
): DirectReceiptOutcome {
  if (failed || !receipt) return { kind: 'sent-unconfirmed' };
  if (receipt.status === 'reverted') return { kind: 'reverted' };
  return { kind: 'confirmed', blockNumber: receipt.blockNumber };
}

const DIRECT_PENDING_PREFIX = 'Your wallet sent this withdrawal';

/** The text of the "sent, not confirmed yet" state. Names the hash. */
export function directPendingMessage(txHash: string): string {
  const short = txHash.length > 14 ? `${txHash.slice(0, 8)}...${txHash.slice(-6)}` : txHash;
  return `${DIRECT_PENDING_PREFIX} (${short}), but it is not confirmed yet. It has not failed and can still land. Do not withdraw these funds again: they are held for it. Check again below, or wait and your balance updates on its own.`;
}

export function isDirectPendingMessage(message: string): boolean {
  return message.startsWith(DIRECT_PENDING_PREFIX);
}

/**
 * Whether the shared error handler may release the submit guard. It must not
 * for the pending state: that run is still in flight on chain.
 */
export function releasesSubmitGuard(message: string): boolean {
  return !isDirectPendingMessage(message);
}
