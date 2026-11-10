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

import type { Hex } from '@/services/sdk-types';
import { interpretPaymentReceipt, type ReplacementReason } from '@/services/tx-finality';

/** The pending-relay record method for a wallet-sent withdrawal. */
export const SELF_WITHDRAW_METHOD = 'selfWithdraw';

export type DirectReceiptOutcome =
  /** The withdrawal executed. `minedHash` is the hash that mined: the
   *  submitted one, or the wallet's sped-up copy of it. */
  | { kind: 'confirmed'; blockNumber: bigint; minedHash: Hex }
  | { kind: 'reverted'; minedHash: Hex }
  /** The wallet cancelled it: a 0-value self-send won the nonce and SUCCEEDED,
   *  so the receipt says success while the withdrawal never ran. */
  | { kind: 'cancelled'; replacementHash: Hex }
  | { kind: 'sent-unconfirmed' };

export type DirectReceipt = { transactionHash: Hex; status: 'success' | 'reverted'; blockNumber: bigint };
export type DirectReplacement = { reason: ReplacementReason; hash: Hex };

/**
 * What a receipt lookup means, through the same replacement rules the wallet
 * payment flow uses (`interpretPaymentReceipt`). `failed` is any throw or a
 * missing client: the transaction may still land, so it is never read as a
 * revert. A contradiction (a generic replacement, a foreign receipt) is not
 * proof either way, so it stays "sent, not confirmed yet" and the inputs stay
 * held until their nullifiers are seen.
 */
export function classifyDirectReceipt(params: {
  submittedHash: Hex;
  receipt: DirectReceipt | null | undefined;
  replacement: DirectReplacement | null;
  failed: boolean;
}): DirectReceiptOutcome {
  const { submittedHash, receipt, replacement, failed } = params;
  if (failed || !receipt) return { kind: 'sent-unconfirmed' };
  const outcome = interpretPaymentReceipt({
    submittedHash,
    receiptHash: receipt.transactionHash,
    receiptSucceeded: receipt.status === 'success',
    replacement,
  });
  switch (outcome.kind) {
    case 'success':
      return { kind: 'confirmed', blockNumber: receipt.blockNumber, minedHash: outcome.finalHash };
    case 'reverted':
      return { kind: 'reverted', minedHash: outcome.finalHash };
    case 'not-sent':
      return { kind: 'cancelled', replacementHash: outcome.replacementHash };
    default:
      return { kind: 'sent-unconfirmed' };
  }
}

/** The slice of a viem PublicClient the own-wallet wait needs. */
export interface DirectReceiptClient {
  waitForTransactionReceipt(args: {
    hash: Hex;
    onReplaced?: (replacement: { reason: ReplacementReason; transaction: { hash: Hex } }) => void;
  }): Promise<DirectReceipt>;
}

/**
 * Wait for a wallet-sent withdrawal and classify it. viem resolves a same-nonce
 * replacement with the REPLACEMENT's receipt and fires `onReplaced` first, so
 * the signal is captured before the receipt is read. A throw is returned as
 * `error` and classified as sent-unconfirmed.
 */
export async function waitForDirectWithdrawal(
  client: DirectReceiptClient | null | undefined,
  hash: Hex,
): Promise<{ outcome: DirectReceiptOutcome; error: unknown }> {
  if (!client) return { outcome: classifyDirectReceipt({ submittedHash: hash, receipt: null, replacement: null, failed: true }), error: null };
  let replacement: DirectReplacement | null = null;
  try {
    const receipt = await client.waitForTransactionReceipt({
      hash,
      onReplaced: (info) => { replacement = { reason: info.reason, hash: info.transaction.hash }; },
    });
    return { outcome: classifyDirectReceipt({ submittedHash: hash, receipt, replacement, failed: false }), error: null };
  } catch (error) {
    return { outcome: classifyDirectReceipt({ submittedHash: hash, receipt: null, replacement, failed: true }), error };
  }
}

/** The text after a wallet cancelled the withdrawal. Nothing was spent. */
export function directCancelledMessage(): string {
  return 'Your wallet cancelled this withdrawal before it ran. Your notes were NOT spent. You can try again.';
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
