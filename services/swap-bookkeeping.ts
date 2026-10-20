// What a confirmed swap leaves behind on this device, in one place per send
// path so each path writes the same records and a test can drive it. Every
// value is already in memory when the swap confirms; nothing here reads the
// network. The stores are injected (they are expo / localStorage backed) so
// this module stays bun-testable.

import type { OwnAction } from '@/services/own-actions-core';
import type { DeliveryOutcome, SwapRecord } from '@/services/swap-records-core';
import { hexKey } from '@/services/swap-rows';
import type { WithdrawFee } from '@/services/withdraw-fees-core';
import type { WithdrawRecipient } from '@/services/withdraw-recipients-core';

export type SwapBookkeepingStores = {
  recordOwnAction: (action: OwnAction) => void;
  recordWithdrawFee: (fee: WithdrawFee) => void;
  recordSwap?: (record: SwapRecord) => void;
  recordSwapDelivery?: (update: { sourceChainId: number; txHash: string; outcome: DeliveryOutcome; destinationTxHash?: string | null }) => void;
  recordWithdrawRecipient?: (entry: WithdrawRecipient) => void;
};

function positive(amount: string | null | undefined): string | null {
  if (!amount) return null;
  try {
    const v = BigInt(amount);
    return v > 0n ? v.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A Swap-tab swap on one chain confirmed. The relayer fee is stamped like a
 * withdrawal's (it is inside the gross that went into the swap, and only this
 * device can split it out). The own-action stamp names the output asset so the
 * new note reads as this swap's while the feed lags; it is written only once
 * the output note is stored locally, as before.
 */
export function recordSameChainSwap(
  input: {
    chainId: number;
    txHash: string | null;
    inputToken: string;
    outputToken: string;
    feeAmount: string | null | undefined;
    /** The output note was added to the local store. */
    noteStored: boolean;
    /** A private swap-send: the output note is another account's. */
    sentToOther?: boolean;
    now: number;
  },
  stores: SwapBookkeepingStores,
): void {
  if (!input.txHash) return;
  const txHash = input.txHash.toLowerCase();
  const fee = positive(input.feeAmount);
  if (fee) {
    stores.recordWithdrawFee({ txHash, feeAmount: fee, tokenAddress: input.inputToken.toLowerCase(), chainId: input.chainId, timestamp: input.now, kind: 'swap' });
  }
  if (input.sentToOther) {
    // The note is the recipient's: no own-action stamp (that would claim it),
    // and no recipient in the record (DEV-512).
    stores.recordSwap?.({ kind: 'send', txHash, sourceChainId: input.chainId, timestamp: input.now, outputChainId: input.chainId, outputToken: input.outputToken.toLowerCase() });
    return;
  }
  if (input.noteStored) {
    stores.recordOwnAction({ kind: 'swap', chainId: input.chainId, txHash, tokenId: input.outputToken.toLowerCase(), timestamp: input.now });
  }
}

/**
 * A Swap-tab swap to another chain relayed its source leg. The record names
 * the destination and the prepared note (intent, not delivery), so this
 * device can show one Swap row and fold the destination deposit in once it
 * lands. The own-action stamp goes on the DESTINATION chain under the source
 * hash, where the prepared note is stored, and only once that note is.
 */
export function recordCrossChainSwap(
  input: {
    sourceChainId: number;
    destinationChainId: number;
    txHash: string | null;
    inputToken: string;
    outputToken: string;
    feeAmount: string | null | undefined;
    note: { commitment?: string | null; value?: string | null } | null | undefined;
    noteStored: boolean;
    /** A private swap-send: the destination note is another account's. */
    sentToOther?: boolean;
    now: number;
  },
  stores: SwapBookkeepingStores,
): void {
  if (!input.txHash) return;
  const txHash = input.txHash.toLowerCase();
  const fee = positive(input.feeAmount);
  if (fee) {
    stores.recordWithdrawFee({ txHash, feeAmount: fee, tokenAddress: input.inputToken.toLowerCase(), chainId: input.sourceChainId, timestamp: input.now, kind: 'swap' });
  }
  if (input.sentToOther) {
    stores.recordSwap?.({ kind: 'send', txHash, sourceChainId: input.sourceChainId, timestamp: input.now, outputChainId: input.destinationChainId, outputToken: input.outputToken.toLowerCase() });
    return;
  }
  const value = positive(input.note?.value);
  if (input.note?.commitment && value) {
    stores.recordSwap?.({
      kind: 'cross-chain',
      txHash,
      sourceChainId: input.sourceChainId,
      timestamp: input.now,
      outputChainId: input.destinationChainId,
      outputToken: input.outputToken.toLowerCase(),
      commitment: hexKey(input.note.commitment),
      value,
    });
  }
  if (input.noteStored) {
    stores.recordOwnAction({ kind: 'swap', chainId: input.destinationChainId, txHash, tokenId: input.outputToken.toLowerCase(), timestamp: input.now });
  }
}

/** The delivery poller learned how a cross-chain swap ended. */
export function recordCrossChainDelivery(
  input: { sourceChainId: number; txHash: string | null; outcome: DeliveryOutcome; destinationTxHash?: string | null },
  stores: SwapBookkeepingStores,
): void {
  if (!input.txHash) return;
  stores.recordSwapDelivery?.({
    sourceChainId: input.sourceChainId,
    txHash: input.txHash.toLowerCase(),
    outcome: input.outcome,
    destinationTxHash: input.destinationTxHash ?? null,
  });
}

/**
 * A Withdraw "receive as" confirmed, on the normal path or after a receipt
 * timeout once the relay settled. The withdrawal is this device's own, its
 * fee is in the input token, and the record keeps the payout token and the
 * quoted payout (the relayed receipt carries no payout).
 */
export function recordReceiveAs(
  input: {
    sourceChainId: number;
    destinationChainId: number;
    txHash: string | null;
    inputToken: string;
    outputToken: string;
    feeAmount: string | null | undefined;
    quotedOutput: string | null | undefined;
    /** The wallet the payout went to. */
    recipient?: string | null;
    now: number;
  },
  stores: SwapBookkeepingStores,
): void {
  if (!input.txHash) return;
  const txHash = input.txHash.toLowerCase();
  stores.recordOwnAction({ kind: 'withdraw', chainId: input.sourceChainId, txHash, timestamp: input.now });
  const fee = positive(input.feeAmount);
  if (fee) {
    stores.recordWithdrawFee({ txHash, feeAmount: fee, tokenAddress: input.inputToken.toLowerCase(), chainId: input.sourceChainId, timestamp: input.now, kind: 'withdrawal' });
  }
  if (input.recipient) {
    stores.recordWithdrawRecipient?.({ txHash, chainId: input.sourceChainId, recipient: input.recipient.toLowerCase(), timestamp: input.now });
  }
  const quoted = positive(input.quotedOutput);
  if (quoted) {
    stores.recordSwap?.({
      kind: 'receive-as',
      txHash,
      sourceChainId: input.sourceChainId,
      timestamp: input.now,
      outputChainId: input.destinationChainId,
      outputToken: input.outputToken.toLowerCase(),
      quotedOutput: quoted,
    });
  }
}

/**
 * A Shield swap-and-shield confirmed. It is a deposit (stamped 'shield' on
 * the deposit's chain, never a swap); the record keeps what the wallet paid,
 * the quote of an exact-output swap, against the deposit note it bought. A
 * swap-and-shield FOR someone else is theirs: the caller records it as an
 * outgoing deposit instead and never calls this.
 */
export function recordShieldSwap(
  input: {
    sourceChainId: number;
    depositChainId: number;
    txHash: string | null;
    inputToken: string;
    estimatedInput: string | null | undefined;
    note: { commitment?: string | null } | null | undefined;
    now: number;
  },
  stores: Pick<SwapBookkeepingStores, 'recordOwnAction' | 'recordSwap'>,
): void {
  if (!input.txHash) return;
  const txHash = input.txHash.toLowerCase();
  stores.recordOwnAction({ kind: 'shield', chainId: input.depositChainId, txHash, timestamp: input.now });
  const paid = positive(input.estimatedInput);
  if (paid && input.note?.commitment) {
    stores.recordSwap?.({
      kind: 'shield',
      txHash,
      sourceChainId: input.sourceChainId,
      timestamp: input.now,
      depositChainId: input.depositChainId,
      inputToken: input.inputToken.toLowerCase(),
      estimatedInput: paid,
      commitment: hexKey(input.note.commitment),
    });
  }
}
