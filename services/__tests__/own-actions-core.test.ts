import { describe, expect, test } from 'bun:test';
import { MAX_OWN_ACTIONS, findOwnActionIn, isOwnDepositOutput, parseOwnActions, toOwnActionMap, upsertOwnAction, type OwnAction } from '@/services/own-actions-core';

const H = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const a = (n: number, kind: OwnAction['kind'] = 'shield', chainId = 1): OwnAction => ({ txHash: H(n), chainId, kind, timestamp: n });
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

describe('own actions', () => {
  test('latest record per (chain, hash) wins, case-insensitive, bounded oldest-out', () => {
    let list: OwnAction[] = [];
    list = upsertOwnAction(list, a(1));
    list = upsertOwnAction(list, { ...a(1, 'withdraw'), txHash: H(1).toUpperCase().replace('0X', '0x') });
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe('withdraw');
    for (let i = 2; i <= MAX_OWN_ACTIONS + 5; i++) list = upsertOwnAction(list, a(i));
    expect(list).toHaveLength(MAX_OWN_ACTIONS);
    expect(findOwnActionIn(list, H(1))).toBeNull(); // the oldest fell out
    expect(findOwnActionIn(list, H(MAX_OWN_ACTIONS + 5))?.kind).toBe('shield');
  });
  test('the same hash on two chains coexists; each chain keeps its own kind', () => {
    let list: OwnAction[] = [];
    list = upsertOwnAction(list, a(7, 'shield', 1));
    list = upsertOwnAction(list, a(7, 'swap', 56));
    expect(list).toHaveLength(2);
    expect(findOwnActionIn(list, H(7), 1)?.kind).toBe('shield');
    expect(findOwnActionIn(list, H(7), 56)?.kind).toBe('swap');
    list = upsertOwnAction(list, a(7, 'withdraw', 56));
    expect(list).toHaveLength(2);
    expect(findOwnActionIn(list, H(7), 1)?.kind).toBe('shield');
    expect(findOwnActionIn(list, H(7), 56)?.kind).toBe('withdraw');
  });
  test('lookup by hash respects the chain; the map is per chain and carries the record', () => {
    const list = [a(1, 'shield', 1), a(2, 'swap', 56)];
    expect(findOwnActionIn(list, H(1), 1)?.kind).toBe('shield');
    expect(findOwnActionIn(list, H(1), 56)).toBeNull();
    expect(findOwnActionIn(list, undefined)).toBeNull();
    expect([...toOwnActionMap(list, 56).entries()]).toEqual([[H(2), a(2, 'swap', 56)]]);
  });
  test('a swap keeps its output asset lowercase; a shield keeps none', () => {
    const list = upsertOwnAction([], { ...a(3, 'swap'), tokenId: USDC });
    expect(list[0].tokenId).toBe(USDC.toLowerCase());
    expect('tokenId' in upsertOwnAction([], a(4))).toBe(false);
  });
  test('only the swap output asset is the deposit; change and unknown-asset swaps claim nothing', () => {
    const swap: OwnAction = { ...a(5, 'swap'), tokenId: USDC.toLowerCase() };
    expect(isOwnDepositOutput(swap, USDC)).toBe(true);
    expect(isOwnDepositOutput(swap, ETH)).toBe(false); // the source-side change
    expect(isOwnDepositOutput(a(6, 'swap'), USDC)).toBe(false); // older record, no asset
    expect(isOwnDepositOutput(a(6, 'shield'), ETH)).toBe(true);
    expect(isOwnDepositOutput(a(6, 'withdraw'), ETH)).toBe(false);
  });
  test('parsing drops junk and keeps well-formed records, with or without an asset', () => {
    const swap = { ...a(2, 'swap'), tokenId: USDC.toLowerCase() };
    expect(parseOwnActions([a(1), swap, { txHash: 'nope', chainId: 1, kind: 'shield', timestamp: 1 }, { ...a(2), kind: 'dance' }, { ...a(3), tokenId: 5 }, null, 'x'])).toEqual([a(1), swap]);
    expect(parseOwnActions('not-a-list')).toEqual([]);
  });

  test('a consolidation record survives parsing', () => {
    expect(parseOwnActions([a(4, 'consolidate')])).toEqual([a(4, 'consolidate')]);
  });
});

import { noteTimeMs, ownDepositBridgeAllowed } from '@/services/own-actions-core';

describe('own deposit bridge (synthesized Deposit row while the feed has no row)', () => {
  const base = { feedLoaded: true, snapshotLoaded: true, snapshotKnows: true, oldestFeedTs: 1_700_000_000_000, noteTs: 1_700_000_500_000, actionTs: 1_700_000_500_500 };
  test('waits for the public feed before it claims anything', () => {
    expect(ownDepositBridgeAllowed({ ...base, feedLoaded: false })).toBe(false);
  });
  test('a fresh deposit bridges whether or not the snapshot has answered', () => {
    expect(ownDepositBridgeAllowed(base)).toBe(true);
    expect(ownDepositBridgeAllowed({ ...base, snapshotKnows: false })).toBe(true);
    expect(ownDepositBridgeAllowed({ ...base, snapshotLoaded: false, snapshotKnows: false })).toBe(true);
    expect(ownDepositBridgeAllowed({ ...base, noteTs: 1_700_000_000_000 })).toBe(true); // equal to the oldest row
  });
  test('older than the window: evicted or old, no row', () => {
    expect(ownDepositBridgeAllowed({ ...base, noteTs: 1_699_999_999_999 })).toBe(false);
    expect(ownDepositBridgeAllowed({ ...base, noteTs: 1_699_999_999_999, snapshotKnows: false })).toBe(false);
  });
  test('a saved old stamp cannot flash while the snapshot is missing or loading', () => {
    const oldStamp = { ...base, noteTs: 0, actionTs: 1_600_000_000_000 };
    expect(ownDepositBridgeAllowed({ ...oldStamp, snapshotLoaded: false, snapshotKnows: false })).toBe(false);
    expect(ownDepositBridgeAllowed({ ...oldStamp, snapshotKnows: false })).toBe(false);
  });
  test('an empty or timestamp-less feed evicts nothing', () => {
    expect(ownDepositBridgeAllowed({ ...base, oldestFeedTs: null, noteTs: 1 })).toBe(true);
    expect(ownDepositBridgeAllowed({ ...base, oldestFeedTs: Number.POSITIVE_INFINITY, noteTs: 1 })).toBe(true);
  });
  test('an unhealed note time is unknown: the action time stands in, never ancient', () => {
    expect(ownDepositBridgeAllowed({ ...base, noteTs: 0 })).toBe(true);
    expect(ownDepositBridgeAllowed({ ...base, noteTs: 0, actionTs: 5 })).toBe(false); // an old stamp
  });
});

describe('noteTimeMs', () => {
  test('a healed unix-seconds time becomes ms; a block number or junk is not a time', () => {
    expect(noteTimeMs('0x' + (1_725_000_000).toString(16))).toBe(1_725_000_000_000);
    expect(noteTimeMs('0x989680')).toBe(0); // block 10,000,000
    expect(noteTimeMs('0x0')).toBe(0);
    expect(noteTimeMs(undefined)).toBe(0);
    expect(noteTimeMs('nope')).toBe(0);
  });
});
