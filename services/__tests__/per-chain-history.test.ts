import { describe, expect, test } from 'bun:test';

import { mergeChainResults, ownTransfersPendingChainIds, pendingHistoryChainIds } from '@/services/per-chain-history';

const ok = <T,>(value: T): PromiseSettledResult<T> => ({ status: 'fulfilled', value });
const failed = <T,>(): PromiseSettledResult<T> => ({ status: 'rejected', reason: new Error('403') });

describe('mergeChainResults', () => {
  test('a failed chain keeps its previous rows', () => {
    const previous = { loadedChainIds: [1, 56], rowsFor: (cid: number) => (cid === 56 ? ['bnb-old'] : ['eth-old']) };
    const merged = mergeChainResults([1, 56], [ok(['eth-new']), failed<string[]>()], previous);
    expect([...merged.rows.entries()]).toEqual([[1, ['eth-new']], [56, ['bnb-old']]]);
    expect(merged.loadedChainIds).toEqual([1, 56]);
  });

  test('a chain that never loaded stays out of loadedChainIds', () => {
    const merged = mergeChainResults([1, 56], [ok(['eth']), failed<string[]>()]);
    expect([...merged.rows.keys()]).toEqual([1]);
    expect(merged.loadedChainIds).toEqual([1]);
  });

  test('fresh rows replace previous rows, in chain order', () => {
    const previous = { loadedChainIds: [1, 56], rowsFor: () => ['old'] };
    const merged = mergeChainResults([56, 1], [ok(['bnb']), ok(['eth'])], previous);
    expect([...merged.rows.entries()]).toEqual([[56, ['bnb']], [1, ['eth']]]);
  });
});

describe('pendingHistoryChainIds', () => {
  const base = { feedChainIds: [1, 56, 102], snapshotChainIds: [1, 56] };

  test('everything loaded is ready', () => {
    expect(pendingHistoryChainIds({
      ...base,
      publicLoadedChainIds: [1, 56, 102],
      snapshotLoadedChainIds: [1, 56],
    })).toEqual([]);
  });

  test('a chain missing from any source is pending', () => {
    expect(pendingHistoryChainIds({
      ...base,
      publicLoadedChainIds: [1, 102],
      snapshotLoadedChainIds: [1, 56],
    })).toEqual([56]);
    expect(pendingHistoryChainIds({
      ...base,
      publicLoadedChainIds: [1, 56, 102],
      snapshotLoadedChainIds: [1],
    })).toEqual([56]);
  });

  test('nothing loaded yet means every chain is pending', () => {
    expect(pendingHistoryChainIds({
      ...base,
      publicLoadedChainIds: undefined,
      snapshotLoadedChainIds: undefined,
    })).toEqual([1, 56, 102]);
  });
});

describe('ownTransfersPendingChainIds', () => {
  const base = { keysHeld: true, snapshotChainIds: [1, 56] };

  test('every chain waits for the snapshot and the first classification', () => {
    expect(ownTransfersPendingChainIds({ ...base, loadedChainIds: undefined, classifiedChainIds: [] })).toEqual([1, 56]);
    expect(ownTransfersPendingChainIds({ ...base, loadedChainIds: [1, 56], classifiedChainIds: [] })).toEqual([1, 56]);
    expect(ownTransfersPendingChainIds({ ...base, loadedChainIds: [1, 56], classifiedChainIds: [1, 56] })).toEqual([]);
  });

  test('a chain whose snapshot loads late waits for a run that covers it', () => {
    // Ethereum was classified while BNB Chain's snapshot failed; the re-run
    // with BNB Chain loaded is still going, and the last run never saw it.
    expect(ownTransfersPendingChainIds({ ...base, loadedChainIds: [1, 56], classifiedChainIds: [1] })).toEqual([56]);
  });

  test('a failed run holds only chains whose snapshot has not loaded', () => {
    expect(ownTransfersPendingChainIds({ ...base, loadedChainIds: [1], classifiedChainIds: null })).toEqual([56]);
  });

  test('without keys nothing can be mine, so nothing waits', () => {
    expect(ownTransfersPendingChainIds({ ...base, keysHeld: false, loadedChainIds: undefined, classifiedChainIds: [] })).toEqual([]);
  });
});
