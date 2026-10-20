import { describe, expect, test } from 'bun:test';

import {
  findWithdrawFeeIn,
  isWithdrawalFee,
  normalizeWithdrawFee,
  parseWithdrawFees,
  toWithdrawalTxHashSet,
  upsertWithdrawFee,
  type WithdrawFee,
} from '@/services/withdraw-fees-core';

const fee = (over: Partial<WithdrawFee> = {}): WithdrawFee => ({
  txHash: '0xAABB',
  feeAmount: '10000000000000000',
  tokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  chainId: 11155111,
  timestamp: 1_800_000_000_000,
  kind: 'withdrawal',
  ...over,
});

describe('normalizeWithdrawFee', () => {
  test('lowercases the compared fields and keeps the amount verbatim', () => {
    const n = normalizeWithdrawFee(fee({ feeAmount: '0x2386F26FC10000' }));
    expect(n.txHash).toBe('0xaabb');
    expect(n.tokenAddress).toBe('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    // Hex from the transfer path and decimal from the withdraw path both round
    // trip untouched: every consumer parses with BigInt(), which takes either.
    expect(n.feeAmount).toBe('0x2386F26FC10000');
    expect(BigInt(n.feeAmount)).toBe(10000000000000000n);
  });
});

describe('upsertWithdrawFee', () => {
  test('one row per tx: a re-quoted retry replaces, never doubles', () => {
    const first = upsertWithdrawFee([], fee({ feeAmount: '100' }));
    const second = upsertWithdrawFee(first, fee({ txHash: '0xaabb', feeAmount: '250' }));
    expect(second).toHaveLength(1);
    expect(second[0].feeAmount).toBe('250');
  });

  test('matches case-insensitively against rows already stored', () => {
    const stored = [normalizeWithdrawFee(fee())];
    expect(upsertWithdrawFee(stored, fee({ txHash: '0xAaBb', feeAmount: '7' }))).toHaveLength(1);
  });

  test('keeps unrelated txs', () => {
    const list = upsertWithdrawFee([normalizeWithdrawFee(fee())], fee({ txHash: '0xCCDD' }));
    expect(list.map((f) => f.txHash)).toEqual(['0xaabb', '0xccdd']);
  });
});

describe('findWithdrawFeeIn', () => {
  test('finds by any hash casing and tolerates a missing hash', () => {
    const list = [normalizeWithdrawFee(fee())];
    expect(findWithdrawFeeIn(list, '0xAABB')?.feeAmount).toBe('10000000000000000');
    expect(findWithdrawFeeIn(list, null)).toBeNull();
    expect(findWithdrawFeeIn(list, '0xffff')).toBeNull();
  });
});

describe('kind discrimination', () => {
  test('a legacy row with no kind still reads as a withdrawal', () => {
    const legacy = fee();
    delete legacy.kind;
    expect(isWithdrawalFee(legacy)).toBe(true);
  });

  test('transfer fees stay OUT of the withdrawal ownership set', () => {
    const legacy = fee({ txHash: '0x1111' });
    delete legacy.kind;
    const list = [
      normalizeWithdrawFee(fee({ txHash: '0xaaaa', kind: 'withdrawal' })),
      normalizeWithdrawFee(fee({ txHash: '0xbbbb', kind: 'transfer' })),
      normalizeWithdrawFee(legacy),
    ];
    const set = toWithdrawalTxHashSet(list);
    // The set is ownership evidence for the accounting scope: a transfer hash
    // entering it would be exported as a withdrawal.
    expect([...set].sort()).toEqual(['0x1111', '0xaaaa']);
    // …but the fee itself is still findable for the transfer's row detail.
    expect(findWithdrawFeeIn(list, '0xbbbb')?.kind).toBe('transfer');
  });
});

describe('parseWithdrawFees', () => {
  test('survives an absent, malformed, or non-array payload', () => {
    expect(parseWithdrawFees(null)).toEqual([]);
    expect(parseWithdrawFees('')).toEqual([]);
    expect(parseWithdrawFees('{ not json')).toEqual([]);
    expect(parseWithdrawFees('{"txHash":"0x1"}')).toEqual([]);
    expect(parseWithdrawFees(JSON.stringify([fee()]))).toHaveLength(1);
  });
});

describe('parseWithdrawFees row validation', () => {
  // The detail panel calls the lookup during render, outside its own try/catch,
  // so one malformed row used to be able to throw while drawing a transaction
  // and to block the next fee stamp. Bad rows are dropped at the parse edge.
  test('drops rows that would throw in a reader, keeping the good ones', () => {
    const good = normalizeWithdrawFee(fee({ txHash: '0xgood' }));
    const raw = JSON.stringify([
      {},                                                  // empty object
      null,                                                // null entry
      'nope',                                              // not an object
      { ...good, txHash: undefined },                      // no hash
      { ...good, txHash: 42 },                             // hash not a string
      { ...good, txHash: '' },                             // empty hash
      { ...good, txHash: '0xa', feeAmount: 10 },           // amount not a string
      { ...good, txHash: '0xb', chainId: 'sepolia' },      // chainId not a number
      { ...good, txHash: '0xc', timestamp: NaN },          // unusable timestamp
      { ...good, txHash: '0xd', kind: 'deposit' },         // unknown kind
      good,
    ]);
    const parsed = parseWithdrawFees(raw);
    expect(parsed.map((f) => f.txHash)).toEqual(['0xgood']);
    // …and every reader survives the mixed payload rather than throwing.
    expect(() => toWithdrawalTxHashSet(parsed)).not.toThrow();
    expect(findWithdrawFeeIn(parsed, '0xGOOD')?.txHash).toBe('0xgood');
  });

  test('a legacy row with no kind survives validation', () => {
    const legacy = fee();
    delete legacy.kind;
    expect(parseWithdrawFees(JSON.stringify([legacy]))).toHaveLength(1);
  });
});
