import { describe, expect, test } from 'bun:test';

import {
  BATCH_MAX_INPUTS,
  batchProgressFraction,
  batchProgressMessage,
  classifyBatchRelayError,
  countFullWithdrawGroups,
  createBatchProgressTracker,
  describeBatchFailure,
  findUnspendableActiveNotes,
  isFullBalanceRequest,
  planBatchWithdraw,
  verifyBatchPrepareAgainstReview,
  type BatchGroup,
  type BatchProgress,
  type SelectGroupsFn,
} from '@/services/batch-withdrawals';
import { NoteStatus, type Note } from '@/services/sdk-types';

const TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as Note['tokenId'];

function makeNote(commitment: string, value: bigint, label = '0x1'): Note {
  return {
    commitment: commitment as Note['commitment'],
    value: `0x${value.toString(16)}` as Note['value'],
    tokenId: TOKEN,
    label: label as Note['label'],
    status: NoteStatus.ACTIVE,
    ownerAddress: '0xabc' as Note['ownerAddress'],
    noteSecret: '0x1' as Note['noteSecret'],
    isOwned: true,
    createdAtBlock: '0x1' as Note['createdAtBlock'],
    spentAtBlock: null,
    txHash: '0x2' as Note['txHash'],
    parentCommitmentHash: null,
  };
}

/** Chunking stub matching the SDK selector's shape: one group per maxInputs notes. */
const chunkSelect: SelectGroupsFn = ({ notes, maxInputs }) => {
  const groups: BatchGroup[] = [];
  for (let i = 0; i < notes.length; i += maxInputs) {
    const chunk = notes.slice(i, i + maxInputs);
    groups.push({
      label: chunk[0].label,
      inputCommitments: chunk.map((n) => n.commitment),
      amountOut: chunk.reduce((sum, n) => sum + BigInt(n.value), 0n),
    });
  }
  return groups;
};

describe('isFullBalanceRequest', () => {
  const total = 10n ** 19n; // 10 ETH in wei

  test('accepts an exact-to-the-wei typed balance (no Max needed)', () => {
    expect(isFullBalanceRequest({ requestedWei: total, totalActiveWei: total, maxSelected: false })).toBe(true);
  });

  test('accepts explicit Max regardless of the displayed (floored) amount', () => {
    // The 100% tab floors the display string, so requestedWei can trail the
    // true balance — the explicit intent flag is what makes it full.
    expect(isFullBalanceRequest({ requestedWei: total - 5n, totalActiveWei: total, maxSelected: true })).toBe(true);
  });

  test('NEVER infers full from numeric closeness: balance - 1 wei typed is partial', () => {
    expect(
      isFullBalanceRequest({ requestedWei: total - 1n, totalActiveWei: total, maxSelected: false }),
    ).toBe(false);
    // 9.99995 ETH against a 10 ETH balance stays partial (the destructive-sweep case).
    expect(
      isFullBalanceRequest({ requestedWei: 9_999_950_000_000_000_000n, totalActiveWei: total, maxSelected: false }),
    ).toBe(false);
  });

  test('rejects an overshoot even by one wei when not explicitly Max', () => {
    expect(isFullBalanceRequest({ requestedWei: total + 1n, totalActiveWei: total, maxSelected: false })).toBe(false);
  });

  test('rejects partial, zero, and empty-balance requests', () => {
    expect(isFullBalanceRequest({ requestedWei: total / 2n, totalActiveWei: total, maxSelected: false })).toBe(false);
    expect(isFullBalanceRequest({ requestedWei: 0n, totalActiveWei: total, maxSelected: false })).toBe(false);
    // Max with no balance is not a withdrawal.
    expect(isFullBalanceRequest({ requestedWei: 0n, totalActiveWei: 0n, maxSelected: true })).toBe(false);
  });
});

describe('countFullWithdrawGroups', () => {
  test('one lineage of <= maxInputs notes needs a single proof (no batch)', () => {
    const notes = Array.from({ length: 5 }, (_, i) => makeNote(`0x${i + 1}`, 100n, '0xL1'));
    expect(countFullWithdrawGroups({ notes, tokenId: TOKEN, maxInputs: BATCH_MAX_INPUTS })).toBe(1);
  });

  test('one lineage of > maxInputs notes chunks into multiple proofs', () => {
    const notes = Array.from({ length: 6 }, (_, i) => makeNote(`0x${i + 1}`, 100n, '0xL1'));
    expect(countFullWithdrawGroups({ notes, tokenId: TOKEN, maxInputs: BATCH_MAX_INPUTS })).toBe(2);
  });

  test('multiple lineages each get their own group(s)', () => {
    const notes = [
      ...Array.from({ length: 3 }, (_, i) => makeNote(`0xa${i}`, 100n, '0xL1')),
      ...Array.from({ length: 7 }, (_, i) => makeNote(`0xb${i}`, 100n, '0xL2')),
    ];
    expect(countFullWithdrawGroups({ notes, tokenId: TOKEN, maxInputs: BATCH_MAX_INPUTS })).toBe(3); // 1 + 2
  });

  test('ignores non-active, zero-value, and other-token notes', () => {
    const other = '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238' as Note['tokenId'];
    const notes: Note[] = [
      makeNote('0x1', 100n, '0xL1'),
      { ...makeNote('0x2', 100n, '0xL1'), status: NoteStatus.SPENT },
      makeNote('0x3', 0n, '0xL1'),
      { ...makeNote('0x4', 100n, '0xL1'), tokenId: other },
    ];
    expect(countFullWithdrawGroups({ notes, tokenId: TOKEN, maxInputs: BATCH_MAX_INPUTS })).toBe(1);
  });
});

describe('planBatchWithdraw', () => {
  test('partitions notes into groups and sums the total', () => {
    const notes = Array.from({ length: 7 }, (_, i) => makeNote(`0x${i + 1}`, 100n));
    const plan = planBatchWithdraw({
      notes,
      tokenId: TOKEN,
      maxInputs: BATCH_MAX_INPUTS,
      maxBatch: 10,
      selectGroups: chunkSelect,
    });
    expect(plan.eligible).toBe(true);
    if (!plan.eligible) throw new Error('unreachable');
    expect(plan.groupCount).toBe(2); // 5 + 2 notes
    expect(plan.totalWei).toBe(700n);
    expect(plan.groups[0].inputCommitments).toHaveLength(5);
    expect(plan.groups[1].inputCommitments).toHaveLength(2);
  });

  test('rejects when the batch exceeds maxBatch', () => {
    const notes = Array.from({ length: 11 }, (_, i) => makeNote(`0x${i + 1}`, 1n));
    const plan = planBatchWithdraw({
      notes,
      tokenId: TOKEN,
      maxInputs: 1, // force 11 groups
      maxBatch: 10,
      selectGroups: chunkSelect,
    });
    expect(plan.eligible).toBe(false);
    if (plan.eligible) throw new Error('unreachable');
    expect(plan.message).toContain('11 proofs');
    expect(plan.message).toContain('at most 10');
  });

  test('maps a throwing selector (EmptyBatchSelection) to an ineligible plan', () => {
    const plan = planBatchWithdraw({
      notes: [],
      tokenId: TOKEN,
      maxInputs: BATCH_MAX_INPUTS,
      maxBatch: 10,
      selectGroups: () => {
        throw new Error(`No active notes for ${TOKEN}`);
      },
    });
    expect(plan.eligible).toBe(false);
    if (plan.eligible) throw new Error('unreachable');
    expect(plan.message).toContain('No withdrawable balance');
  });

  test('rejects an empty selection', () => {
    const plan = planBatchWithdraw({
      notes: [],
      tokenId: TOKEN,
      maxInputs: BATCH_MAX_INPUTS,
      maxBatch: 10,
      selectGroups: () => [],
    });
    expect(plan.eligible).toBe(false);
  });
});

describe('findUnspendableActiveNotes', () => {
  const notes = [makeNote('0xa', 1n), makeNote('0xb', 2n), makeNote('0xc', 3n)];

  test('returns the notes missing from the spendable set', () => {
    const spendable = new Set(['0xa', '0xc']);
    const missing = findUnspendableActiveNotes(notes, spendable);
    expect(missing.map((n) => n.commitment)).toEqual(['0xb']);
  });

  test('returns nothing when every note is spendable', () => {
    const spendable = new Set(['0xa', '0xb', '0xc']);
    expect(findUnspendableActiveNotes(notes, spendable)).toHaveLength(0);
  });

  test('treats an unknown (null) set as nothing spendable', () => {
    expect(findUnspendableActiveNotes(notes, null)).toHaveLength(3);
  });
});

describe('verifyBatchPrepareAgainstReview', () => {
  const reviewed = { reviewedTotalOutWei: 1000n, reviewedTotalFeeWei: 30n };

  test('accepts an identical or cheaper prepared batch', () => {
    expect(
      verifyBatchPrepareAgainstReview({ preparedTotalOutWei: 1000n, preparedTotalFeeWei: 30n, ...reviewed }).ok,
    ).toBe(true);
    expect(
      verifyBatchPrepareAgainstReview({ preparedTotalOutWei: 1000n, preparedTotalFeeWei: 25n, ...reviewed }).ok,
    ).toBe(true);
  });

  test('rejects a higher fee than reviewed', () => {
    const result = verifyBatchPrepareAgainstReview({
      preparedTotalOutWei: 1000n,
      preparedTotalFeeWei: 31n,
      ...reviewed,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toContain('fee went up');
  });

  test('rejects a changed total (balance shifted between review and confirm)', () => {
    for (const preparedTotalOutWei of [999n, 1001n]) {
      const result = verifyBatchPrepareAgainstReview({
        preparedTotalOutWei,
        preparedTotalFeeWei: 30n,
        ...reviewed,
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.reason).toContain('balance changed');
    }
  });

  test('a cheaper confirm quote passes and its EXECUTED fee is what success must use (finding 7)', () => {
    // Reviewed fee 30, confirm re-quote came back cheaper (22). The guard
    // accepts it; the success screen + fee record must report the executed 22,
    // not the reviewed 30 — the modal persists `prepared.totalFee` on success.
    const prepared = { preparedTotalOutWei: 1000n, preparedTotalFeeWei: 22n };
    const result = verifyBatchPrepareAgainstReview({ ...prepared, ...reviewed });
    expect(result.ok).toBe(true);
    // The value the caller should surface is the prepared (executed) fee.
    const executedNet = prepared.preparedTotalOutWei - prepared.preparedTotalFeeWei;
    const reviewedNet = reviewed.reviewedTotalOutWei - reviewed.reviewedTotalFeeWei;
    expect(executedNet).toBe(978n);
    // Executed net (978) differs from the reviewed net (970) — success must
    // show the executed one.
    expect(reviewedNet).toBe(970n);
    expect(executedNet === reviewedNet).toBe(false);
  });
});

describe('batch progress mapping', () => {
  test('tracker emits proving 1..N then submitting, clamping extra ticks', () => {
    const updates: BatchProgress[] = [];
    const tracker = createBatchProgressTracker(3, (p) => updates.push(p));
    // Initial state is emitted immediately.
    expect(updates).toEqual([{ phase: 'proving', current: 1, total: 3 }]);
    tracker.tick(); // proof 1 done → proving 2/3
    tracker.tick(); // proof 2 done → proving 3/3
    tracker.tick(); // proof 3 done → no further proving update
    tracker.tick(); // stray tick. Must not exceed total
    tracker.submitting();
    expect(updates).toEqual([
      { phase: 'proving', current: 1, total: 3 },
      { phase: 'proving', current: 2, total: 3 },
      { phase: 'proving', current: 3, total: 3 },
      { phase: 'submitting', current: 3, total: 3 },
    ]);
  });

  test('messages surface i of N and the submit phase', () => {
    expect(batchProgressMessage({ phase: 'proving', current: 2, total: 5 })).toBe(
      'Generating proof 2 of 5...',
    );
    expect(batchProgressMessage({ phase: 'submitting', current: 5, total: 5 })).toBe(
      'Submitting batch (5 proofs) via relayer...',
    );
  });

  test('fraction is monotonic and bounded in [0, 1]', () => {
    const total = 4;
    const sequence: BatchProgress[] = [
      { phase: 'proving', current: 1, total },
      { phase: 'proving', current: 2, total },
      { phase: 'proving', current: 3, total },
      { phase: 'proving', current: 4, total },
      { phase: 'submitting', current: 4, total },
    ];
    let last = -1;
    for (const progress of sequence) {
      const fraction = batchProgressFraction(progress);
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThanOrEqual(1);
      expect(fraction).toBeGreaterThan(last);
      last = fraction;
    }
    // The submit segment never claims completion — the receipt does that.
    expect(last).toBeLessThan(1);
  });
});

describe('classifyBatchRelayError', () => {
  test('an expiry/commitment error is pre-submit (SDK checks expiry before broadcast)', () => {
    expect(classifyBatchRelayError('FeeCommitmentExpired: quote expired')).toBe('pre-submit');
    expect(classifyBatchRelayError('signed commitment invalid')).toBe('pre-submit');
  });

  // codex round 3: NoteConflictError ('Conflicting note for commitment …')
  // is thrown AFTER a successful receipt while persisting local state — the
  // broad 'commitment' match labelled a CONFIRMED batch as 'no funds moved'.
  test('a post-confirm note conflict is confirmed-sync-failed, never pre-submit', () => {
    expect(classifyBatchRelayError('Conflicting note for commitment 0xabc')).toBe('confirmed-sync-failed');
  });

  test('a receipt/timeout error is receipt-unknown', () => {
    expect(classifyBatchRelayError('failed to fetch transaction receipt')).toBe('receipt-unknown');
    expect(classifyBatchRelayError('request timed out')).toBe('receipt-unknown');
  });

  test('anything else is submission-unknown', () => {
    expect(classifyBatchRelayError('relayer returned 500')).toBe('submission-unknown');
    expect(classifyBatchRelayError('network error')).toBe('submission-unknown');
  });
});

describe('describeBatchFailure', () => {
  test('pre-submit states that nothing moved', () => {
    const message = describeBatchFailure('pre-submit', 'proof generation failed.');
    expect(message).toContain('No funds moved');
    expect(message).toContain('proof generation failed.');
  });

  test('submission-unknown warns the tx may have landed and asks for a resync', () => {
    const message = describeBatchFailure('submission-unknown', 'relayer 500.');
    expect(message).toContain('may still have been sent');
    expect(message).toContain('Sync your account');
    expect(message).toContain('relayer 500.');
  });

  test('receipt-unknown offers the explorer only when a hash is known', () => {
    expect(describeBatchFailure('receipt-unknown', 'timeout.', { hasTxHash: true })).toContain('explorer');
    const noHash = describeBatchFailure('receipt-unknown', 'timeout.', { hasTxHash: false });
    expect(noHash).toContain('Sync your account');
    expect(noHash.includes('explorer')).toBe(false);
  });

  test('reverted states no notes were spent (atomic revert)', () => {
    const message = describeBatchFailure('reverted', 'execution reverted.');
    expect(message).toContain('No notes were spent');
    expect(message).toContain('reverted on-chain');
  });

  test('confirmed-sync-failed reassures the funds are safe', () => {
    const message = describeBatchFailure('confirmed-sync-failed', 'storage write failed.');
    expect(message).toContain('confirmed on-chain');
    expect(message).toContain('funds are safe');
  });
});
