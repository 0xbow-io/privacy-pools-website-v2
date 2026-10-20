/**
 * Which answer a chain row in the registration card shows (DEV-440).
 *
 * PURE (no react-native imports) so bun can pin it.
 *
 * The card caches one on-chain read per chain. A registration that lands after
 * its modal was closed is orphaned on purpose (it may not resume the caller),
 * but it still writes 'complete' to the receive-setup store. The card never
 * looked at the store for any chain but the active one, so the row kept its
 * cached "Not registered" until a reload.
 *
 * Registration only moves forward within a session: unregistered, then partial
 * (auth policy set, viewing key not yet), then compatible. So a store answer
 * further along than the cached read wins. 'incompatible' is never replaced:
 * that is a different unlock, not progress.
 */

export type RowStatus = 'unknown' | 'unregistered' | 'partial' | 'compatible' | 'incompatible';

const RANK: Record<RowStatus, number> = { unknown: 0, unregistered: 1, partial: 2, compatible: 3, incompatible: -1 };

export function rowStatus(cached: RowStatus | undefined, stored: RowStatus | null): RowStatus | undefined {
  if (!stored || stored === 'unknown') return cached;
  if (cached === undefined) return undefined;
  if (cached === 'incompatible' || stored === 'incompatible') return cached;
  return RANK[stored] > RANK[cached] ? stored : cached;
}
