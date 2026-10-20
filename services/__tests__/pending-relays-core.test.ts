import { describe, expect, test } from 'bun:test';
import {
  addPendingRelay,
  canOverride,
  findBlockingRelay,
  isPendingRelayBlocked,
  landedTxHash,
  settledByOtherSpend,
  overrideRelay,
  parsePendingRelays,
  PENDING_RELAY_OVERRIDE_AFTER_MS,
  PENDING_RELAY_TTL_MS,
  PendingRelayBlockedError,
  relayRequestNullifiers,
  settleByReceipt,
  settleBySpends,
  spendsFromSnapshot,
  type PendingRelay,
} from '../pending-relays-core';

const hash = (b: string) => `0x${b.repeat(32)}`;
const pad = (h: string) => `0x${h.slice(2).padStart(64, '0')}`;
const N1 = '0x1111';
const N2 = '0x2222';
const N3 = '0x3333';
const T0 = 1_790_000_000_000;

function relay(overrides: Partial<PendingRelay> = {}): PendingRelay {
  return { id: `1:${hash('aa')}`, chainId: 1, method: 'relayTransfer', nullifiers: [N1, N2], txHash: hash('aa'), owner: null, at: T0, ...overrides };
}

describe('relayRequestNullifiers', () => {
  test('reads the first inputNullifierNumber public signals, padding-insensitively', () => {
    const params = { proof: { proof: {}, publicSignals: [pad(N1), pad(N2), pad(N3), '0x99'] }, inputNullifierNumber: 2, outputCommitmentNumber: 2 };
    expect(relayRequestNullifiers(params)).toEqual([N1, N2]);
  });

  test('covers batch items and a withdrawal wrapped one level down', () => {
    const item = (n: string) => ({ proof: { publicSignals: [n, '0x5'] }, inputNullifierNumber: 1 });
    expect(relayRequestNullifiers({ items: [item(N1), item(N2)] }).sort()).toEqual([N1, N2]);
    expect(relayRequestNullifiers({ registration: { account: '0xabc' }, withdrawal: item(N3) })).toEqual([N3]);
  });

  test('nothing for params without a proof, or a count past the signals', () => {
    expect(relayRequestNullifiers(undefined)).toEqual([]);
    expect(relayRequestNullifiers({ commit: true })).toEqual([]);
    expect(relayRequestNullifiers({ proof: { publicSignals: [N1] }, inputNullifierNumber: 3 })).toEqual([]);
  });
});

describe('blocking', () => {
  test('a pending relay blocks any spend sharing one of its nullifiers, on its chain only', () => {
    const list = addPendingRelay([], relay(), T0);
    expect(findBlockingRelay(list, 1, [pad(N2), N3], T0 + 1000)?.id).toBe(list[0].id);
    expect(findBlockingRelay(list, 1, [N3], T0 + 1000)).toBeNull();
    expect(findBlockingRelay(list, 10, [N1], T0 + 1000)).toBeNull();
  });

  test('the newest of several blocking relays is named', () => {
    const list = addPendingRelay(addPendingRelay([], relay(), T0), relay({ id: 'b', txHash: hash('bb'), at: T0 + 5 }), T0 + 5);
    expect(findBlockingRelay(list, 1, [N1], T0 + 10)?.txHash).toBe(hash('bb'));
  });

  test('override is offered only after the wait, and an overridden relay stops blocking', () => {
    const r = relay();
    expect(canOverride(r, T0 + PENDING_RELAY_OVERRIDE_AFTER_MS - 1)).toBe(false);
    expect(canOverride(r, T0 + PENDING_RELAY_OVERRIDE_AFTER_MS)).toBe(true);
    const list = overrideRelay([r], r.id, T0 + PENDING_RELAY_OVERRIDE_AFTER_MS);
    expect(findBlockingRelay(list, 1, [N1], T0 + PENDING_RELAY_OVERRIDE_AFTER_MS)).toBeNull();
  });

  test('an expired relay neither blocks nor survives the next write', () => {
    const later = T0 + PENDING_RELAY_TTL_MS;
    expect(findBlockingRelay([relay()], 1, [N1], later)).toBeNull();
    expect(addPendingRelay([relay()], relay({ id: 'c', txHash: hash('cc'), at: later }), later).map((r) => r.id)).toEqual(['c']);
  });

  test('the refusal names no hash or nullifier and is recognisable from its message', () => {
    const err = new PendingRelayBlockedError(relay(), T0 + 3 * 60_000);
    expect(err.message).not.toContain(hash('aa'));
    expect(err.message).not.toContain(N1);
    expect(isPendingRelayBlocked(err.message)).toBe(true);
    expect(err.message).not.toContain('Send anyway');
    expect(new PendingRelayBlockedError(relay(), T0 + PENDING_RELAY_OVERRIDE_AFTER_MS).message).toContain('Send anyway');
  });
});

describe('settling', () => {
  test('DEV-458: the earlier attempt lands and settles both attempts, only one as its own hash', () => {
    const a = relay({ id: 'a', txHash: hash('aa') });
    const b = relay({ id: 'b', txHash: hash('bb'), at: T0 + 200_000 });
    const other = relay({ id: 'o', txHash: hash('dd'), nullifiers: [N3] });
    const { kept, settled } = settleBySpends([a, b, other], 1, spendsFromSnapshot([{ txHash: hash('aa'), nullifierHashes: [pad(N1), pad(N2)] }]));
    expect(kept.map((r) => r.id)).toEqual(['o']);
    expect(settled.map((s) => [s.record.id, s.spentBy, s.ownHash])).toEqual([['a', hash('aa'), true], ['b', hash('aa'), false]]);
    expect(settled.map((s) => landedTxHash(s))).toEqual([hash('aa'), null]);
    expect(settled.map((s) => settledByOtherSpend(s))).toEqual([false, true]);
  });

  test('a spend seen without its hash is spent, not a revert, and lands as the relayer\'s hash', () => {
    const { settled } = settleBySpends([relay()], 1, [{ txHash: null, nullifiers: [N1] }]);
    expect(settled[0]).toMatchObject({ spent: true, spentBy: null, ownHash: false });
    expect(settledByOtherSpend(settled[0])).toBe(false);
    expect(landedTxHash(settled[0])).toBe(hash('aa'));
  });

  test('a spend on another chain settles nothing', () => {
    expect(settleBySpends([relay()], 10, [{ txHash: hash('aa'), nullifiers: [N1] }]).settled).toEqual([]);
  });

  test('a receipt settles its own record: spent when it succeeded, unspent when it reverted', () => {
    expect(settleByReceipt([relay()], hash('aa').toUpperCase().replace('0X', '0x'), true).settled[0]).toMatchObject({ spentBy: hash('aa'), ownHash: true });
    const reverted = settleByReceipt([relay()], hash('aa'), false).settled[0];
    expect(reverted).toMatchObject({ spent: false, spentBy: null, ownHash: false });
    expect(landedTxHash(reverted)).toBeNull();
    expect(settleByReceipt([relay()], hash('bb'), true).kept).toHaveLength(1);
  });
});

test('parse drops malformed records', () => {
  expect(parsePendingRelays([relay(), { ...relay(), txHash: '0x12' }, null, 'x'])).toHaveLength(1);
  expect(parsePendingRelays('nope')).toEqual([]);
});
