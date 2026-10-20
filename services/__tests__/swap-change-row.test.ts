import { describe, expect, test } from 'bun:test';

import { classifyTransfer, isOwnSwapChangeRow } from '@/services/transfer-direction';
import type { Note } from '@/services/sdk-types';
import type { Transaction } from '@/components/pools-provider';

// DEV-455 (QA 2026-10-01, prod BNB Chain): after a BNB -> USDT private swap the
// BNB pool's feed row read "Transfer In 0.00934 BNB", which is only the change
// note of the spent BNB.
const SWAP_TX = '0x' + '5a'.repeat(32);
const BNB = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const USDT = '0x55d398326f99059ff775485246999027b3197955';

const row = { id: 'r', type: 'Transfer', txHash: SWAP_TX, tokenAddress: BNB, label: null, chainId: 56 } as unknown as Transaction;
const note = (tokenId: string, value: bigint, txHash = SWAP_TX) => ({
  commitment: '0x' + value.toString(16), txHash, tokenId, value: '0x' + value.toString(16), label: '0x1', status: 'ACTIVE',
}) as unknown as Note;

const change = note(BNB, 9_340_000_000_000_000n);
const output = note(USDT, 10_730_000_000_000_000_000n);

describe('a swap\'s change note is not a Transfer In', () => {
  test('change plus my output note in another token: my swap, not a receipt', () => {
    expect(isOwnSwapChangeRow(row, [change, output])).toBe(true);
    expect(classifyTransfer(row, [change, output])).toBeNull();
  });

  test('a swap-send paid to me (only my output note under the hash) is not mine to explain either', () => {
    expect(isOwnSwapChangeRow(row, [output])).toBe(true);
  });

  test('a real received transfer still reads Transfer In', () => {
    expect(isOwnSwapChangeRow(row, [change])).toBe(false);
    expect(classifyTransfer(row, [change])).toBe('in');
  });

  test('notes from other txs do not count', () => {
    expect(isOwnSwapChangeRow(row, [change, note(USDT, 1n, '0x' + '11'.repeat(32))])).toBe(false);
  });

  test('a stamped send keeps its direction', () => {
    expect(classifyTransfer(row, [change, output], new Set([SWAP_TX]))).toBe('out');
  });

  test('non-EVM token ids are never compared', () => {
    expect(isOwnSwapChangeRow({ ...row, tokenAddress: '0x2::sui::SUI' }, [change, output])).toBe(false);
    expect(isOwnSwapChangeRow(row, [change, note('0x2::sui::SUI', 1n)])).toBe(false);
  });

  test('only Transfer rows', () => {
    expect(isOwnSwapChangeRow({ ...row, type: 'Deposit' }, [change, output])).toBe(false);
  });
});
