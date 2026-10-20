// What a confirmed plain withdrawal leaves behind on this device, in one place
// so every withdrawal path writes the same records. Values are those already
// in memory at confirmation; nothing reads the network. Stores are injected
// (they are expo / localStorage backed) so this stays bun-testable.

import type { OwnAction } from '@/services/own-actions-core';
import type { WithdrawFee } from '@/services/withdraw-fees-core';
import type { WithdrawRecipient } from '@/services/withdraw-recipients-core';

export type WithdrawBookkeepingStores = {
  recordOwnAction: (action: OwnAction) => void;
  recordWithdrawFee: (fee: WithdrawFee) => void;
  recordWithdrawRecipient: (entry: WithdrawRecipient) => void;
};

/**
 * A withdrawal of this account confirmed. The own-action stamp keeps the
 * change note from reading as received while the snapshot lags; the fee is
 * the split the feed's gross cannot show; the recipient names where the
 * money went, which the public feed mostly does not.
 */
export function recordOwnWithdrawal(
  input: {
    chainId: number;
    txHash: string | null | undefined;
    recipient: string | null | undefined;
    tokenAddress: string;
    feeAmount: string | number | bigint | null | undefined;
    /** Stamp the own action too (the batch path has never stamped one). */
    stampOwnAction: boolean;
    now: number;
  },
  stores: WithdrawBookkeepingStores,
): void {
  if (!input.txHash) return;
  const txHash = input.txHash.toLowerCase();
  if (input.stampOwnAction) stores.recordOwnAction({ kind: 'withdraw', chainId: input.chainId, txHash, timestamp: input.now });
  if (input.feeAmount !== null && input.feeAmount !== undefined) {
    stores.recordWithdrawFee({ txHash, feeAmount: String(input.feeAmount), tokenAddress: input.tokenAddress, chainId: input.chainId, timestamp: input.now, kind: 'withdrawal' });
  }
  if (input.recipient) {
    stores.recordWithdrawRecipient({ txHash, chainId: input.chainId, recipient: input.recipient.toLowerCase(), timestamp: input.now });
  }
}
