import { describe, expect, test } from 'bun:test';

import {
  classifyTransfer,
  computeUserTransferAmount,
  isHeldForSpendClassification,
  isInternalSpendRow,
  mergeMyTransactions,
  withLineageTransfers,
} from '@/services/transfer-direction';
import { NoteStatus, type Note } from '@/services/sdk-types';
import type { Transaction } from '@/components/pools-provider';

const txHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function transferTx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: '1',
    type: 'Transfer',
    txHash,
    label: null,
    timestamp: Date.now(),
    rawAmount: '100',
    totalValue: '$1.00',
    asset: {
      symbol: 'ETH',
      tokenAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      decimals: 18,
    },
    status: 'accepted',
    ...overrides,
  } as Transaction;
}

function note(overrides: Partial<Note> = {}): Note {
  return {
    commitment: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    value: '0x64',
    tokenId: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    label: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    status: NoteStatus.ACTIVE,
    ownerAddress: '0x1111111111111111111111111111111111111111',
    noteSecret: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    isOwned: true,
    createdAtBlock: '0x1',
    spentAtBlock: null,
    txHash,
    parentCommitmentHash: null,
    ...overrides,
  };
}

describe('classifyTransfer', () => {
  test('classifies locally stamped transfers as outgoing', () => {
    expect(classifyTransfer(transferTx(), [note()], new Set([txHash]))).toBe('out');
  });

  test('classifies owned active notes from the transfer tx as incoming', () => {
    expect(classifyTransfer(transferTx(), [note()])).toBe('in');
  });

  test('returns null for unrelated transfers', () => {
    expect(classifyTransfer(transferTx({ txHash }), [
      note({ txHash: '0x9999999999999999999999999999999999999999999999999999999999999999' }),
    ])).toBeNull();
  });

  test('returns null for non-transfer transactions', () => {
    expect(classifyTransfer(transferTx({ type: 'Deposit' }), [note()], new Set([txHash]))).toBeNull();
  });

  test('classifies a received-then-SPENT note as incoming (not "?")', () => {
    // A transfer you received and later spent stays a received transfer in your
    // history; its now-spent note is the only 'in' signal. Skipping spent notes
    // here left it undecodable while the ownership filter still showed the row.
    expect(
      classifyTransfer(transferTx(), [note({ status: NoteStatus.SPENT, spentAtBlock: '0x5' })]),
    ).toBe('in');
  });
});

describe('computeUserTransferAmount', () => {
  test('incoming transfer decodes the amount from a since-SPENT note', () => {
    const amount = computeUserTransferAmount(
      transferTx(),
      [note({ status: NoteStatus.SPENT, spentAtBlock: '0x5' })],
      'in',
      null,
    );
    expect(amount).toBe(100n); // note value 0x64, even though it's now spent
  });

  test('a claim receipt row keeps its own amount, not the claim change under its hash (DEV-450)', () => {
    // Fallback claim row keyed by the claim tx: the note under that hash is
    // the change (value minus the claim cost), which must not replace it.
    const amount = computeUserTransferAmount(
      transferTx({ rawAmount: '1000', claimTxHash: txHash, claimCostRaw: '65' }),
      [note({ value: '0x3a3' })],
      'in',
      null,
    );
    expect(amount).toBe(1000n);
  });

  test('outgoing transfer still uses the local sent stamp, never the note scan', () => {
    const amount = computeUserTransferAmount(
      transferTx(),
      [note({ status: NoteStatus.SPENT, spentAtBlock: '0x5' })],
      'out',
      '250',
    );
    expect(amount).toBe(250n);
  });
});

describe('mergeMyTransactions (#215 codex)', () => {
  const spendTx = '0x1111111111111111111111111111111111111111111111111111111111111111';

  test('prefers the reconstructed spend row over the mislabeled ASP row for the same tx', () => {
    // ASP row for the spend, still in the windowed feed, with no direction —
    // would be mislabeled 'in' on a device with no local sent-stamp.
    const aspRow = transferTx({ id: 'asp', txHash: spendTx, timestamp: 100 });
    // Reconstructed 'out' lineage row for the same tx.
    const lineageOut = transferTx({
      id: 'lineage-out',
      txHash: spendTx,
      timestamp: 100,
      direction: 'out',
      isLineageSynthetic: true,
    });

    const merged = mergeMyTransactions([aspRow], [lineageOut]);

    expect(merged.length).toBe(1);
    expect(merged[0].id).toBe('lineage-out');
    expect(merged[0].direction).toBe('out');
  });

  test('prefers a reconstructed self-transfer row over the raw ASP spend row for the same tx', () => {
    const aspRow = transferTx({ id: 'asp', txHash: spendTx, timestamp: 100 });
    const selfRow = transferTx({
      id: 'lineage-self',
      direction: 'self',
      txHash: spendTx,
      timestamp: 100,
      isLineageSynthetic: true,
    } as never);

    const merged = mergeMyTransactions([aspRow], [selfRow]);

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('lineage-self');
    expect(merged[0].direction).toBe('self');
  });

  test('drops a stamped anchor ASP row even when NO lineage row exists yet', () => {
    // The window Pat hit on the keystoreless run, 2026-09-01. The activity feed
    // and the event snapshot are different ASP endpoints with different lag:
    // right after a claim the feed already carries the anchor while the
    // snapshot does not, so reconstructUserSpends produces no lineage row to
    // suppress against, and the user's own anchor output showed as a second
    // "Transfer In" of money nobody sent them. The local stamp closes it
    // without guessing at a delay.
    const aspRow = transferTx({ id: 'asp-anchor', txHash: spendTx, timestamp: 100 });

    const merged = mergeMyTransactions([aspRow], [], new Set([spendTx.toLowerCase()]));

    expect(merged).toHaveLength(0);
  });

  test('an unstamped tx with no lineage row is still kept, so the stamp only ever removes MY anchors', () => {
    const otherTx = '0x3333333333333333333333333333333333333333333333333333333333333333';
    const aspRow = transferTx({ id: 'asp-other', txHash: otherTx, timestamp: 100 });

    const merged = mergeMyTransactions([aspRow], [], new Set([spendTx.toLowerCase()]));

    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('asp-other');
  });

  test('keeps ASP rows that have no lineage counterpart, and sorts newest-first', () => {
    const otherTx = '0x2222222222222222222222222222222222222222222222222222222222222222';
    const aspRow = transferTx({ id: 'asp', txHash: otherTx, timestamp: 50 });
    const lineageIn = transferTx({
      id: 'lineage-in',
      txHash: spendTx,
      timestamp: 200,
      direction: 'in',
      isLineageSynthetic: true,
    });

    const merged = mergeMyTransactions([aspRow], [lineageIn]);

    expect(merged.length).toBe(2);
    expect(merged[0].id).toBe('lineage-in'); // newer first
    expect(merged[1].id).toBe('asp');
  });

  test('a Deposit row that shares the spend tx hash survives the merge (reshield)', () => {
    // The reshield's Withdrawal lineage row replaces the feed's withdrawal row,
    // but the same tx also carries the feed's Deposit row for the new note;
    // that one must stay (Pat, 2026-08-30).
    const withdrawalRow = transferTx({ type: 'Withdrawal', txHash: '0xreshield' } as never);
    const depositRow = transferTx({ type: 'Deposit', txHash: '0xreshield', id: 'dep' } as never);
    const lineageWithdrawal = transferTx({ type: 'Withdrawal', txHash: '0xreshield', id: 'lineage' } as never);
    const merged = mergeMyTransactions([withdrawalRow, depositRow], [lineageWithdrawal]);
    expect(merged.filter((t) => t.type === 'Deposit')).toHaveLength(1);
    expect(merged.filter((t) => t.type === 'Withdrawal')).toHaveLength(1);
    expect(merged.find((t) => t.type === 'Withdrawal')?.id).toBe('lineage');
  });
});

describe('computeUserTransferAmount. Multi-lineage receives', () => {
  const secondNote = (over: Partial<Note> = {}) => note({
    commitment: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    value: '0x64',
    ...over,
  });

  test('sums BOTH outputs of a two-lineage receive (14+14 shows 28, not 14)', () => {
    const amount = computeUserTransferAmount(
      transferTx(),
      [note({ value: '0xe' }), secondNote({ value: '0xe' })],
      'in',
      null,
    );
    expect(amount).toBe(28n);
  });

  test('sums a two-output receive even after both notes were SPENT', () => {
    const amount = computeUserTransferAmount(
      transferTx(),
      [
        note({ value: '0xe', status: NoteStatus.SPENT, spentAtBlock: '0x9' }),
        secondNote({ value: '0xe', status: NoteStatus.SPENT, spentAtBlock: '0x9' }),
      ],
      'in',
      null,
    );
    expect(amount).toBe(28n);
  });

  test('dedupes repeated commitments instead of double-counting', () => {
    const amount = computeUserTransferAmount(
      transferTx(),
      [note({ value: '0xe' }), note({ value: '0xe' })], // same commitment twice
      'in',
      null,
    );
    expect(amount).toBe(14n);
  });
});

describe('isInternalSpendRow', () => {
  const internal = new Set([txHash]);

  // The bug this exists to prevent: a reshield spends notes and re-deposits the
  // swapped value in the SAME tx, so its hash is an internal-spend hash AND a
  // real Deposit hash. Dropping by bare hash swallowed the deposit (Pat saw a
  // signed wallet show 22 rows where an account-key session showed 23).
  test('never suppresses a Deposit, even when its tx hash is an internal spend', () => {
    expect(isInternalSpendRow({ type: 'Deposit', txHash }, internal)).toBe(false);
  });

  test('suppresses non-Deposit rows whose tx hash is an internal spend', () => {
    expect(isInternalSpendRow({ type: 'Transfer', txHash }, internal)).toBe(true);
    expect(isInternalSpendRow({ type: 'Withdrawal', txHash }, internal)).toBe(true);
  });

  test('keeps rows whose tx hash is not an internal spend', () => {
    expect(isInternalSpendRow({ type: 'Transfer', txHash: '0xbeef' }, internal)).toBe(false);
    expect(isInternalSpendRow({ type: 'Transfer', txHash: null }, internal)).toBe(false);
  });

  test('matches tx hashes case-insensitively', () => {
    expect(isInternalSpendRow({ type: 'Transfer', txHash: txHash.toUpperCase() }, internal)).toBe(true);
  });
});

describe('a reshield output never explains the source pool row (DEV-455)', () => {
  const BNB = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const FDUSD = '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409';
  // The swap tx spent a BNB note and deposited an FDUSD note under one hash.
  const row = transferTx({ tokenAddress: BNB, label: null });
  const fdusdOutput = note({ tokenId: FDUSD as Note['tokenId'], value: '0xd3a26dfb6f07f3000' });

  test('the output note of another token does not make the row Transfer In', () => {
    expect(classifyTransfer(row, [fdusdOutput])).toBeNull();
  });

  test('nor lends it its amount', () => {
    expect(computeUserTransferAmount(row, [fdusdOutput], 'in', null)).toBeNull();
  });

  test('a note of the row token alone still does', () => {
    const bnbNote = note({ tokenId: BNB as Note['tokenId'] });
    expect(classifyTransfer(row, [bnbNote])).toBe('in');
  });

  test('but next to my output note it is the swap\'s change, not a Transfer In (QA 2026-10-01)', () => {
    const bnbNote = note({ tokenId: BNB as Note['tokenId'] });
    expect(classifyTransfer(row, [bnbNote, fdusdOutput])).toBeNull();
    expect(computeUserTransferAmount(row, [bnbNote, fdusdOutput], 'in', null)).toBe(100n);
  });
});

describe('the token guard ignores non-EVM token ids (DEV-455 review)', () => {
  test('a Sui note with a random 32-byte tokenId still explains its row', () => {
    const suiId = `0x${'ab'.repeat(32)}`;
    const row = transferTx({ tokenAddress: `0x${'cd'.repeat(32)}`, label: null });
    const n = note({ tokenId: suiId as Note['tokenId'] });
    expect(classifyTransfer(row, [n])).toBe('in');
  });
});

describe('withLineageTransfers', () => {
  test("the All tab shows my transfer as its reconstructed row and leaves a stranger's alone", () => {
    // A receipt on another chain than the session's: its feed row has no notes
    // to decode it with and read "Transfer · Private".
    // My consolidation's feed row is typed Transfer too, and without its own
    // row the table read its own output note as an incoming payment.
    const mine = transferTx({ id: 'feed-mine' });
    const consolidation = transferTx({ id: 'feed-consolidation', txHash: `0x${'b'.repeat(64)}` });
    const strangers = transferTx({ id: 'feed-other', txHash: `0x${'c'.repeat(64)}` });
    const deposit = transferTx({ id: 'feed-deposit', type: 'Deposit' } as Partial<Transaction>);
    const received = transferTx({ id: 'lineage-x', direction: 'in', isLineageSynthetic: true } as Partial<Transaction>);
    const self = transferTx({ id: 'lineage-self', direction: 'self', txHash: `0x${'b'.repeat(64)}` } as Partial<Transaction>);
    expect(withLineageTransfers([mine, consolidation, strangers, deposit], [received, self]).map((t) => t.id))
      .toEqual(['lineage-x', 'lineage-self', 'feed-other', 'feed-deposit']);
  });

  test('my withdrawal the feed read as a transfer shows as my Withdrawal row', () => {
    // A relayed ppETH withdrawal from four notes across three deposits left
    // three change notes, so the feed's arity guess typed it Transfer and the
    // All tab read "Transfer · Private" about my own withdrawal.
    const misread = transferTx({ id: 'feed-misread' });
    const feedWithdrawal = transferTx({ id: 'feed-withdrawal', type: 'Withdrawal', txHash: `0x${'d'.repeat(64)}` } as Partial<Transaction>);
    const myWithdrawal = transferTx({ id: 'lineage-out-w', type: 'Withdrawal', direction: undefined, isLineageSynthetic: true } as Partial<Transaction>);
    const otherWithdrawal = transferTx({ id: 'lineage-out-d', type: 'Withdrawal', direction: undefined, txHash: `0x${'d'.repeat(64)}` } as Partial<Transaction>);
    const rows = withLineageTransfers([misread, feedWithdrawal], [myWithdrawal, otherWithdrawal]);
    // A feed row already typed Withdrawal keeps its own published fields.
    expect(rows.map((t) => `${t.id}:${t.type}`)).toEqual(['lineage-out-w:Withdrawal', 'feed-withdrawal:Withdrawal']);
  });

  test("a batch tx keeps every feed row: none is mine for sure, and a stranger's is never replaced", () => {
    const stranger = transferTx({ id: 'feed-batch-1', label: '0x01' } as Partial<Transaction>);
    const mine = transferTx({ id: 'feed-batch-2', label: '0x02' } as Partial<Transaction>);
    const myWithdrawal = transferTx({ id: 'lineage-w', type: 'Withdrawal', direction: undefined, isLineageSynthetic: true } as Partial<Transaction>);
    expect(withLineageTransfers([stranger, mine], [myWithdrawal]).map((t) => t.id)).toEqual(['feed-batch-1', 'feed-batch-2']);
  });
});

describe('the DEV-394 hold', () => {
  const pending = { pending: true, sentTxHashes: new Set<string>(), isPaidRequest: () => false };

  test('holds a feed Transfer row while my spends are being classified, and only then', () => {
    // Feed rows are typed 'Transfer'. The hold compared against 'transfer' and
    // so never held one.
    expect(isHeldForSpendClassification(transferTx(), pending)).toBe(true);
    expect(isHeldForSpendClassification(transferTx(), { ...pending, pending: false })).toBe(false);
  });

  test('a row this device stamped keeps its known direction', () => {
    const upper = transferTx({ txHash: `0x${txHash.slice(2).toUpperCase()}` });
    expect(isHeldForSpendClassification(upper, { ...pending, sentTxHashes: new Set([txHash]) })).toBe(false);
    expect(isHeldForSpendClassification(transferTx(), { ...pending, isPaidRequest: (h) => h === txHash })).toBe(false);
  });
});

describe('DEV-574: a claim submitted by the recipient\'s own device', () => {
  test('is a Transfer In even when this device stamped the tx as sent', () => {
    const sent = new Set([txHash]);
    // The claim's receipt row carries the claim tx.
    expect(classifyTransfer(transferTx({ claimTxHash: txHash }), [], sent)).toBe('in');
    // The feed row of a confirmed claim (anchor stamp).
    expect(classifyTransfer(transferTx(), [], sent, new Set([txHash]))).toBe('in');
    // A real send keeps its direction.
    expect(classifyTransfer(transferTx(), [], sent)).toBe('out');
  });
});
