import type { QueryClient } from '@tanstack/react-query';

/**
 * The query keys a confirmed write re-reads: queries whose queryFn reads data
 * this client already holds and never sends a request.
 *
 * Only those. Every own write calls this at confirmation, so a network-backed
 * key here is a request timed to that transaction, which tells the ASP (or the
 * RPC provider) which on-chain operation was this client's. Feeds refresh on
 * their own cadence (services/public-feed-scheduler.ts), and our own operation
 * shows from what the flow already knows locally: the activity ledger
 * (services/feed-reconciliation.ts) and the note manager.
 *
 * `services/__tests__/transaction-cache-keys.test.ts` fails when a key here is
 * network-backed or has no query behind it.
 */
export const TRANSACTION_CACHE_KEYS: readonly (readonly string[])[] = [
  // A re-read of the event snapshot the feed grid holds (services/snapshot-source.ts).
  // Prefix only: the query is keyed by the joined chain list.
  ['eventSnapshot'],
];

/**
 * Re-read every local query that shows transaction state, after a write that
 * touched chain state, so every page reflects what this client already knows.
 * Asks nothing of the network, so there is nothing to repeat later: anything
 * newer arrives with the next feed tick.
 */
export function invalidateTransactionCaches(
  queryClient: QueryClient,
  _params: { chainId?: number; address?: string } = {},
): Promise<void[]> {
  return Promise.all(TRANSACTION_CACHE_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey: [...queryKey] })));
}
