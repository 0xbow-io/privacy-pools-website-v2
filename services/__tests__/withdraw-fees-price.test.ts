import { describe, expect, test } from 'bun:test';
import { parseWithdrawFees, withSendTimePrice, type WithdrawFee } from '../withdraw-fees-core';

const fee: WithdrawFee = {
  txHash: '0xabc', feeAmount: '600000000000000', tokenAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', chainId: 1, timestamp: 1, kind: 'withdrawal',
};

describe('send-time fee price', () => {
  test('a non-stablecoin fee keeps the price it was paid at', () => {
    expect(withSendTimePrice(fee, 2500, false).priceUsd).toBe(2500);
  });

  test('a stablecoin fee, an unknown price or an existing price is left alone', () => {
    expect(withSendTimePrice(fee, 1, true).priceUsd).toBeUndefined();
    expect(withSendTimePrice(fee, undefined, false).priceUsd).toBeUndefined();
    expect(withSendTimePrice(fee, 0, false).priceUsd).toBeUndefined();
    expect(withSendTimePrice({ ...fee, priceUsd: 2400 }, 2500, false).priceUsd).toBe(2400);
  });

  test('stored rows round-trip the price; a malformed price drops the row', () => {
    const rows = parseWithdrawFees(JSON.stringify([{ ...fee, priceUsd: 2500 }, { ...fee, txHash: '0xdef', priceUsd: 'x' }, { ...fee, txHash: '0x123' }]));
    expect(rows.map((r) => [r.txHash, r.priceUsd])).toEqual([['0xabc', 2500], ['0x123', undefined]]);
  });
});
