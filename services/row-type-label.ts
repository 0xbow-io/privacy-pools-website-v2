import { selfTransferLabel, type NoteCounts } from '@/services/self-transfer-row';

/**
 * The row's type as shown to the user. One user action is one row, and the
 * label follows what happened to the user's balance (DEV-575); the full table
 * is docs/activity-labels.md.
 */
export function rowTypeLabel(tx: {
  type: string;
  direction?: string;
  noteCounts?: NoteCounts;
  viaSwap?: boolean;
  sentToOther?: boolean;
  swappedFrom?: unknown;
  receivedAs?: unknown;
  /** A deposit this wallet made for someone else (isDepositAuthoredByMe). */
  authored?: boolean;
  /** All uses neutral deposit labels; details and Mine may name the payer. */
  scope?: 'all' | 'mine';
  /** A claim whose transaction also registered the account (DEV-574). */
  withRegistration?: boolean;
  /** A relayed spend made only to set up the account (DEV-574). */
  setupKind?: 'registration' | 'gas-top-up';
}): string {
  // Setup paid from the balance: named for what it was, never a Withdrawal
  // or a transfer to myself.
  if (tx.setupKind === 'gas-top-up') return 'Gas for viewing key';
  if (tx.setupKind === 'registration') return 'Account setup';
  if (tx.direction === 'self') return selfTransferLabel(tx.noteCounts);
  if (tx.type === 'Transfer' && tx.direction === 'in') return tx.withRegistration ? 'Transfer In & registration' : 'Transfer In';
  if (tx.type === 'Transfer' && tx.direction === 'out') return 'Transfer Out';
  // A private swap-send: the output note went to another account (DEV-512).
  if (tx.type === 'Withdrawal' && tx.sentToOther) return 'Sent to another account';
  // Whose money it is outranks how it was paid for.
  if (tx.type === 'Deposit' && tx.authored && tx.scope !== 'all') return 'Deposit to recipient';
  if (tx.type === 'Deposit' && tx.swappedFrom) return 'Deposit via swap';
  if (tx.type === 'Withdrawal' && (tx.receivedAs || tx.viaSwap)) return 'Withdrawal via swap';
  return tx.type;
}
