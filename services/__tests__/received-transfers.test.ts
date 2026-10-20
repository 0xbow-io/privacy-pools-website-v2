import { describe, expect, test } from 'bun:test';

import { normalizeCommitment } from '@/services/deposit-ownership';
import { collectReceivedTransfers, onlyClassifiedNotes, receiptSkipTxHashes, tagNotesByChain, type ReceivedNoteLike } from '@/services/received-transfers';

const BSC = 56;
const ETH = 1;
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

function note(commitment: string, txHash: string, value: bigint, status = 'ACTIVE'): ReceivedNoteLike {
  return { commitment, txHash, value: `0x${value.toString(16)}`, tokenId: NATIVE, label: '0xaa', status };
}

const none = new Set<string>();
const base = {
  skipTxHashes: none,
  depositCommitments: none,
  sessionChainId: ETH,
  loadedChainIds: [ETH, BSC],
  pendingChainIds: [] as number[],
  spendChainIds: new Set<number>(),
};

describe('collectReceivedTransfers', () => {
  test('a transfer received on another chain than the session is a receipt on its own chain', () => {
    // Mike, 2026-10-07: eight BNB Chain receipts read "Transfer · Private"
    // while the session was on another network.
    const candidates = tagNotesByChain(
      { chainId: ETH, notes: [] },
      [{ chainId: BSC, notes: [note(hash(1), hash(100), 5n), note(hash(2), hash(101), 7n)] }],
    );
    const received = collectReceivedTransfers(candidates, base);
    expect(received.map((r) => [r.txHash, r.chainId, r.sum])).toEqual([
      [hash(100), BSC, 5n],
      [hash(101), BSC, 7n],
    ]);
  });

  test('the snapshot names the chain when it has the tx', () => {
    const candidates = tagNotesByChain(null, [{ chainId: ETH, notes: [note(hash(1), hash(100), 5n)] }]);
    const received = collectReceivedTransfers(candidates, { ...base, txChainIds: new Map([[hash(100), BSC]]) });
    expect(received[0].chainId).toBe(BSC);
  });

  test('a multi-lineage receipt is one row with every note summed, each commitment once', () => {
    // The live copy and a stored copy of the same note must not double it.
    const candidates = tagNotesByChain(
      { chainId: BSC, notes: [note(hash(1), hash(100), 14n)] },
      [{ chainId: BSC, notes: [note(hash(1), hash(100), 14n), note(hash(2), hash(100), 14n)] }],
    );
    const received = collectReceivedTransfers(candidates, { ...base, sessionChainId: BSC });
    expect(received).toHaveLength(1);
    expect(received[0].sum).toBe(28n);
  });

  test('a deposit output, on any chain, is a deposit root and not a receipt', () => {
    // Snapshot commitments are decimal, notes are hex: both sides are canonical.
    const candidates = tagNotesByChain(null, [{ chainId: BSC, notes: [note('0x1f', hash(100), 1n)] }]);
    const snapshotCommitment = normalizeCommitment('31');
    const received = collectReceivedTransfers(candidates, { ...base, depositCommitments: new Set([snapshotCommitment!]) });
    expect(received).toEqual([]);
  });

  test("no receipts on a chain whose history has not loaded: its deposits and spends are missing too", () => {
    const candidates = tagNotesByChain(null, [{ chainId: BSC, notes: [note(hash(1), hash(100), 5n)] }]);
    expect(collectReceivedTransfers(candidates, { ...base, loadedChainIds: [ETH] })).toEqual([]);
    expect(collectReceivedTransfers(candidates, { ...base, pendingChainIds: [BSC] })).toEqual([]);
  });

  test("another chain's notes count only once its own spends can be matched", () => {
    // A chain on another key scheme matches none of my spends, so the change of
    // an own send there would read as a receipt. It has SPENT notes, so it has
    // own spends, and none of them was found.
    const otherScheme = [
      note(hash(1), hash(100), 10n, 'SPENT'),
      note(hash(2), hash(101), 9n),
    ];
    const candidates = tagNotesByChain(null, [{ chainId: BSC, notes: otherScheme }]);
    expect(collectReceivedTransfers(candidates, base)).toEqual([]);
    // Once a spend there is matched, its change is skipped by tx hash and the
    // rest are receipts.
    const matched = collectReceivedTransfers(candidates, {
      ...base,
      spendChainIds: new Set([BSC]),
      skipTxHashes: new Set([hash(101)]),
    });
    expect(matched.map((r) => r.txHash)).toEqual([hash(100)]);
    // The session chain is always classified.
    expect(collectReceivedTransfers(candidates, { ...base, sessionChainId: BSC })).toHaveLength(2);
  });
  test("a payer's change is never a receipt, even before the snapshot has the payment", () => {
    // Paying a request records no own action, and until the snapshot has the tx
    // it is not a reconstructed spend either: only the paid-request stamp knows.
    // The feed's own Transfer row is no reason to skip; a Deposit row is.
    const skip = receiptSkipTxHashes({
      spends: [{ txHash: hash(1), kind: 'transfer' }, { txHash: hash(2), kind: 'claim', receivedTxHash: hash(3) }],
      anchorTxHashes: [hash(4)],
      localTxHashes: [hash(5).toUpperCase().replace('0X', '0x')],
      rows: [{ type: 'Deposit', txHash: hash(6) }, { type: 'Transfer', txHash: hash(7) }],
    });
    const candidates = tagNotesByChain(null, [{ chainId: BSC, notes: [1, 2, 3, 4, 5, 6, 7].map((n) => note(hash(n + 10), hash(n), 1n)) }]);
    expect(collectReceivedTransfers(candidates, { ...base, skipTxHashes: skip }).map((r) => r.txHash)).toEqual([hash(7)]);
  });
});

describe('onlyClassifiedNotes', () => {
  test("while a new run is pending, a note the last run never saw cannot become a receipt", () => {
    // hash(2) is the change of a send made after the last run: with the last
    // run's spends it is not an own spend yet, so it must not be counted.
    const known = note(hash(1), hash(100), 5n);
    const arrived = note(hash(2), hash(101), 3n);
    const candidates = tagNotesByChain(null, [{ chainId: BSC, notes: [known, arrived] }]);
    const stillShown = onlyClassifiedNotes(candidates, [{ ...known, commitment: hash(1).toUpperCase().replace('0X', '0x') }]);
    expect(collectReceivedTransfers(stillShown, base).map((r) => r.txHash)).toEqual([hash(100)]);
  });

  test('a receipt spent since the last run keeps its row until the next run lands', () => {
    // Spending the BSC receipt makes BSC a chain with SPENT notes, and the last
    // run found no BSC spend, so with current statuses the chain is ineligible
    // and its receipts vanish mid-run. The last run's copy says ACTIVE.
    const nowSpent = note(hash(1), hash(100), 5n, 'SPENT');
    const candidates = tagNotesByChain(null, [{ chainId: BSC, notes: [nowSpent] }]);
    expect(collectReceivedTransfers(candidates, base)).toEqual([]);
    const asClassified = onlyClassifiedNotes(candidates, [note(hash(1), hash(100), 5n)]);
    expect(collectReceivedTransfers(asClassified, base).map((r) => r.txHash)).toEqual([hash(100)]);
  });
});
