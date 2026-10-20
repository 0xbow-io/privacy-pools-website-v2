import { useSyncExternalStore } from 'react';

import { readPendingOwnRows, subscribePendingOwnRows } from '@/services/pending-own-rows-store';

/**
 * This client's operations the activity feed does not describe yet, as a
 * stable array reference (services/pending-own-rows-store.ts). Purely local:
 * reading it cannot cause a request.
 */
export function usePendingOwnRows() {
  return useSyncExternalStore(subscribePendingOwnRows, readPendingOwnRows, readPendingOwnRows);
}
