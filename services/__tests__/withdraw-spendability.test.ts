import { describe, expect, test } from 'bun:test';

import {
  buildWithdrawSpendabilityKey,
  partitionSuiWithdrawNotes,
  resolveWithdrawSpendableCommitments,
} from '@/services/withdraw-spendability';

const note = (commitment: string, label: string, status = 'ACTIVE') => ({
  commitment,
  label,
  status,
});

describe('withdraw spendability request identity', () => {
  test('note ordering does not create a new request identity', () => {
    const a = note('0x1', '0xa');
    const b = note('0x2', '0xb');
    const base = { chainId: 1, isSui: false, owner: '0xABC' };
    expect(buildWithdrawSpendabilityKey({ ...base, notes: [a, b] })).toBe(
      buildWithdrawSpendabilityKey({ ...base, notes: [b, a] }),
    );
  });

  test('chain, owner, commitment, and label changes invalidate the old answer', () => {
    const base = buildWithdrawSpendabilityKey({
      chainId: 1,
      isSui: false,
      owner: '0xabc',
      notes: [note('0x1', '0xa')],
    });
    const variants = [
      buildWithdrawSpendabilityKey({ chainId: 10, isSui: false, owner: '0xabc', notes: [note('0x1', '0xa')] }),
      buildWithdrawSpendabilityKey({ chainId: 1, isSui: false, owner: '0xdef', notes: [note('0x1', '0xa')] }),
      buildWithdrawSpendabilityKey({ chainId: 1, isSui: false, owner: '0xabc', notes: [note('0x2', '0xa')] }),
      buildWithdrawSpendabilityKey({ chainId: 1, isSui: false, owner: '0xabc', notes: [note('0x1', '0xb')] }),
    ];
    for (const variant of variants) expect(variant).not.toBe(base);
  });

  test('a Sui ASP verdict change invalidates the review identity', () => {
    const pending = buildWithdrawSpendabilityKey({
      chainId: 2,
      isSui: true,
      owner: '0xsui',
      notes: [{ commitment: '1', label: '2', status: 'active' }],
    });
    const approved = buildWithdrawSpendabilityKey({
      chainId: 2,
      isSui: true,
      owner: '0xsui',
      notes: [{ commitment: '1', label: '2', status: 'active', aspApproved: true }],
    });
    const rejected = buildWithdrawSpendabilityKey({
      chainId: 2,
      isSui: true,
      owner: '0xsui',
      notes: [{ commitment: '1', label: '2', status: 'active', aspApproved: false }],
    });
    expect(new Set([pending, approved, rejected]).size).toBe(3);
  });

  test('a result is visible only to the exact request that produced it', () => {
    const keyA = buildWithdrawSpendabilityKey({
      chainId: 1,
      isSui: false,
      owner: '0xabc',
      notes: [note('0x1', '0xa')],
    });
    const keyB = buildWithdrawSpendabilityKey({
      chainId: 10,
      isSui: false,
      owner: '0xabc',
      notes: [note('0x2', '0xb')],
    });
    const commitments = new Set(['0x1']);
    const resolution = { key: keyA, commitments };

    expect(resolveWithdrawSpendableCommitments(resolution, keyA)).toBe(commitments);
    expect(resolveWithdrawSpendableCommitments(resolution, keyB)).toBeNull();
    expect(resolveWithdrawSpendableCommitments(null, keyA)).toBeNull();
    expect(resolveWithdrawSpendableCommitments({ key: keyA, commitments: new Set() }, keyA)).toEqual(new Set());
  });
});

describe('Sui withdraw spendability', () => {
  test('only an explicit approval is spendable and unknown keeps the flow loading', () => {
    const approved = { commitment: '1', status: 'active', aspApproved: true };
    const pending = { commitment: '2', status: 'active' };
    const rejected = { commitment: '3', status: 'active', aspApproved: false };
    const spent = { commitment: '4', status: 'spent', aspApproved: true };
    const result = partitionSuiWithdrawNotes([approved, pending, rejected, spent]);
    expect(result.approvedNotes).toEqual([approved]);
    expect(result.approvalPending).toBe(true);
  });

  test('loaded rejected/empty states are resolved rather than pending forever', () => {
    expect(partitionSuiWithdrawNotes([
      { status: 'active', aspApproved: false },
      { status: 'spent' },
    ])).toEqual({ approvedNotes: [], approvalPending: false });
    expect(partitionSuiWithdrawNotes([])).toEqual({ approvedNotes: [], approvalPending: false });
  });
});
