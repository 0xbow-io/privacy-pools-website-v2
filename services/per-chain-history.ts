/**
 * Per-chain load state for the multi-chain history reads (public feed, event
 * snapshot). One chain failing must neither blank the others nor
 * erase what that chain already returned: a refetch that fails for one chain
 * keeps its last good rows, and a chain that has never loaded is reported as
 * pending so nothing downstream reads its absence as "no activity".
 */

export type PreviousChainRows<T> = {
  loadedChainIds: readonly number[];
  rowsFor: (chainId: number) => T;
};

export type MergedChainRows<T> = {
  /** In `chainIds` order. */
  rows: Map<number, T>;
  loadedChainIds: number[];
};

/** `settled[i]` is the result for `chainIds[i]`. */
export function mergeChainResults<T>(
  chainIds: readonly number[],
  settled: readonly PromiseSettledResult<T>[],
  previous?: PreviousChainRows<T>,
): MergedChainRows<T> {
  const rows = new Map<number, T>();
  const loadedChainIds: number[] = [];
  chainIds.forEach((cid, i) => {
    const result = settled[i];
    if (result?.status === 'fulfilled') {
      rows.set(cid, result.value);
      loadedChainIds.push(cid);
    } else if (previous?.loadedChainIds.includes(cid)) {
      rows.set(cid, previous.rowsFor(cid));
      loadedChainIds.push(cid);
    }
  });
  return { rows, loadedChainIds };
}

/**
 * Feed chains whose history is not complete yet: the public feed or, for
 * snapshot chains, the event snapshot has not loaded for them.
 */
export function pendingHistoryChainIds(input: {
  feedChainIds: readonly number[];
  snapshotChainIds: readonly number[];
  publicLoadedChainIds: readonly number[] | undefined;
  snapshotLoadedChainIds: readonly number[] | undefined;
}): number[] {
  return input.feedChainIds.filter((cid) => {
    if (!input.publicLoadedChainIds?.includes(cid)) return true;
    return input.snapshotChainIds.includes(cid) && !input.snapshotLoadedChainIds?.includes(cid);
  });
}

/**
 * Snapshot chains where a Transfer row may still turn out to be mine, so it
 * must not read "Private" yet: keys are held and either the chain's event
 * snapshot has not loaded or no completed classification of my spends covers
 * it. `classifiedChainIds` is the loaded set of the snapshot behind the spends
 * on screen, or null when no classification is coming (a failed run).
 */
export function ownTransfersPendingChainIds(input: {
  keysHeld: boolean;
  snapshotChainIds: readonly number[];
  /** The current snapshot's loaded chains; undefined before it has loaded. */
  loadedChainIds: readonly number[] | undefined;
  classifiedChainIds: readonly number[] | null;
}): number[] {
  if (!input.keysHeld) return [];
  const { loadedChainIds: loaded, classifiedChainIds: classified } = input;
  return input.snapshotChainIds.filter((cid) => !loaded?.includes(cid) || (classified !== null && !classified.includes(cid)));
}
