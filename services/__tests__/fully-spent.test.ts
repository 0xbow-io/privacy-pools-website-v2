import { describe, expect, test } from 'bun:test';

import { fullySpentDepositTxHashes, fullySpentDepositTxHashesByChain } from '../fully-spent';

const live = (s: string) => s === 'ACTIVE' || s === 'PENDING' || s === 'INACTIVE' || s === 'REJECTED';
const T = (sec: number) => `0x${(1_790_000_000 + sec).toString(16)}`;
const n = (label: string, value: string, status: string, txHash: string, at?: number) => ({
  label, value, status, parentCommitmentHash: null, txHash, ...(at !== undefined ? { createdAtBlock: T(at) } : {}),
});

describe('fullySpentDepositTxHashes', () => {
  test('a reshield tx with a dead source change and a live new deposit is NOT fully spent', () => {
    const notes = [
      n('0xsrc', '0x5', 'SPENT', '0xdeposit1', 0),
      n('0xsrc', '0x0', 'ACTIVE', '0xreshield', 10),
      n('0xnew', '0x10', 'PENDING', '0xreshield', 10),
    ];
    const spent = fullySpentDepositTxHashes(notes, live);
    expect(spent.has('0xreshield')).toBe(false);
    expect(spent.has('0xdeposit1')).toBe(true);
  });

  test('a partial reshield: a live source change does not keep a fully withdrawn new deposit alive', () => {
    const notes = [
      n('0xa', '0xa', 'SPENT', '0xdepA', 0),
      n('0xa', '0x5', 'ACTIVE', '0xreshield', 10),
      n('0xb', '0x4', 'SPENT', '0xreshield', 10),
      n('0xb', '0x0', 'ACTIVE', '0xwithdrawB', 20),
    ];
    const spent = fullySpentDepositTxHashes(notes, live);
    expect(spent.has('0xreshield')).toBe(true);
    expect(spent.has('0xdepa')).toBe(false);
  });

  test('without usable times, a lineage counts toward every tx it has a note in (previous behaviour)', () => {
    const notes = [n('0xa', '0x5', 'SPENT', '0xd'), n('0xa', '0x0', 'ACTIVE', '0xw')];
    const spent = fullySpentDepositTxHashes(notes, live);
    expect(spent.has('0xd')).toBe(true);
    expect(fullySpentDepositTxHashes([n('0xa', '0x5', 'ACTIVE', '0xd')], live).has('0xd')).toBe(false);
  });

  test('a later live note in the same lineage keeps the deposit alive, case-insensitively', () => {
    const notes = [n('0xAA', '0x5', 'SPENT', '0xD', 0), n('0xaa', '0x3', 'ACTIVE', '0xt', 5)];
    expect(fullySpentDepositTxHashes(notes, live).has('0xd')).toBe(false);
  });
});

describe('fullySpentDepositTxHashesByChain', () => {
  test("each chain's deposits are judged by that chain's notes, whichever chain is selected", () => {
    const byChain = new Map([
      // A BNB Chain deposit fully withdrawn there.
      [56, [n('0xbsc', '0x5', 'SPENT', '0xdepBsc', 0), n('0xbsc', '0x0', 'ACTIVE', '0xwdBsc', 10)]],
      // An Ethereum deposit still holding value.
      [1, [n('0xeth', '0x5', 'ACTIVE', '0xdepEth', 0)]],
    ]);
    const spent = fullySpentDepositTxHashesByChain(byChain, live);
    expect(spent.get(56)?.has('0xdepbsc')).toBe(true);
    expect(spent.get(1)?.has('0xdepeth')).toBe(false);
    // One chain's verdicts never appear under another's.
    expect(spent.get(1)?.has('0xdepbsc')).toBe(false);
  });

  test("a cross-chain swap's source hash on two chains is judged on each chain apart", () => {
    const byChain = new Map([
      // Source chain: the swap spent the deposit; its 0-value change is dead.
      [1, [n('0xsrc', '0x5', 'SPENT', '0xdep', 0), n('0xsrc', '0x0', 'ACTIVE', '0xswap', 10)]],
      // Destination: the delivered note, a new lineage stored under the source hash, still live.
      [56, [n('0xout', '0x9', 'ACTIVE', '0xswap', 20)]],
    ]);
    const spent = fullySpentDepositTxHashesByChain(byChain, live);
    expect(spent.get(56)?.has('0xswap')).toBe(false);
    expect(spent.get(1)?.has('0xdep')).toBe(true);
  });
});
