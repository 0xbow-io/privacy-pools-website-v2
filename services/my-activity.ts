/**
 * "Mine" filtering for the home surfaces, from PUBLIC data only.
 *
 * Deliberately keystore-free: note-derived ownership needs a signed session, so
 * anything built on it is empty for a user who has merely connected a wallet.
 * The ASP event feed carries the counterparty address in the clear, which is the
 * same basis the notification centre's "mine" tab uses.
 */

export interface MyActivityRow {
  /** Tx hash, when the row carries one (lets callers exclude stamped deposits). */
  txHash?: string | null;
  /** Public address on the event — depositor, or withdrawal recipient. */
  fullAddress?: string;
  type?: string;
  tokenAmount?: number;
}

function sameAddress(a: string | undefined, target: string): boolean {
  return (a ?? '').toLowerCase() === target;
}

/**
 * The rows attributable to `address`, order preserved.
 *
 * Returns an EMPTY array when there is no address — never the full list. A
 * "mine" view that silently falls back to everyone else's activity is worse
 * than an empty one.
 */
export function selectMyActivity<T extends MyActivityRow>(
  transactions: readonly T[] | null | undefined,
  address: string | null | undefined,
): T[] {
  if (!transactions?.length || !address) return [];
  const target = address.toLowerCase();
  return transactions.filter((tx) => sameAddress(tx.fullAddress, target));
}

/** How many deposits this address has made, per the public feed. */
export function countMyDeposits(
  transactions: readonly MyActivityRow[] | null | undefined,
  address: string | null | undefined,
  /** Tx hashes (lowercase) this wallet submitted FOR someone else: ownership,
   *  not authorship, so they do not count as the user's deposits. */
  excludeTxHashes?: ReadonlySet<string>,
): number {
  if (!transactions?.length || !address) return 0;
  const target = address.toLowerCase();
  return transactions.filter(
    (tx) => sameAddress(tx.fullAddress, target)
      && (tx.type ?? '').toLowerCase() === 'deposit'
      && !(excludeTxHashes && tx.txHash && excludeTxHashes.has(String(tx.txHash).toLowerCase())),
  ).length;
}
