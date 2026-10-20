import { useCallback, useSyncExternalStore } from 'react';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';
import { usePoolSession } from '@/hooks/use-pool-session';
import { getSnapshotFor, subscribe } from '@/services/payroll-store';

// Reactive view of the local payroll store. Re-renders on any CRUD/import.
// Scoped to the session identity (a key session has no wallet address), and
// the store scopes by environment itself, so staging records never show on
// prod and one account never sees another's team.
export function usePayroll() {
  const { address: connectedAddress } = useMultiChainWallet();
  const { sessionAddress } = usePoolSession();
  const owner = sessionAddress ?? connectedAddress ?? null;
  const read = useCallback(() => getSnapshotFor(owner), [owner]);
  return useSyncExternalStore(subscribe, read, read);
}
