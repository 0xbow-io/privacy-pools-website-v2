/**
 * Balance vs history disagreement.
 *
 * Two surfaces answer "did this deposit land?" from two different sources, and
 * they can disagree:
 *   - My transactions reads the ASP event. Approved review -> "completed".
 *   - The per-pool balance row refuses to count a deposit it has no matching
 *     local note for, so the same deposit reads "0.0100 ETH pending".
 * Neither is lying. The row is deliberately cautious (an approved deposit with
 * no note is not PROVEN spendable), and the caution exists because counting it
 * as balance once masked a stranded change-note bug.
 *
 * The usual cause is benign and self-correcting: discovery has not
 * materialised the note yet. The balance memo collects the disagreeing
 * deposits so the row and the balance agree by construction
 * (services/deposit-row-chain.ts). Nothing resyncs because of them: the extra
 * discovery passes that used to were a request pattern only the accounts with
 * such a deposit produced, and the feed grid's regular discovery pass settles
 * it for everyone on one schedule.
 */

/**
 * A deposit the balance counted pending, and the chain it happened on.
 */
export interface PendingDeposit {
  /** Lowercase deposit tx hash. */
  txHash: string;
  chainId: number;
}
