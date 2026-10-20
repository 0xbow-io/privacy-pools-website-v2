import { describe, expect, test } from 'bun:test';
import { recordSameChainSwap } from '../swap-bookkeeping';
import type { OwnAction } from '../own-actions-core';
import type { WithdrawFee } from '../withdraw-fees-core';

const TX = `0x${'AB'.repeat(32)}`;
function stores() {
  const actions: OwnAction[] = [];
  const fees: WithdrawFee[] = [];
  return { actions, fees, sink: { recordOwnAction: (a: OwnAction) => actions.push(a), recordWithdrawFee: (f: WithdrawFee) => fees.push(f) } };
}
const base = { chainId: 1, txHash: TX, inputToken: '0xEEEE', outputToken: '0xA0B8', feeAmount: '0x221b262dd8000', noteStored: true, now: 5 };

describe('same-chain swap bookkeeping', () => {
  test('a confirmed swap stamps its fee in the input token and the swap with its output asset', () => {
    const s = stores();
    recordSameChainSwap(base, s.sink);
    expect(s.fees).toEqual([{ txHash: TX.toLowerCase(), feeAmount: '600000000000000', tokenAddress: '0xeeee', chainId: 1, timestamp: 5, kind: 'swap' }]);
    expect(s.actions).toEqual([{ kind: 'swap', chainId: 1, txHash: TX.toLowerCase(), tokenId: '0xa0b8', timestamp: 5 }]);
  });

  test('an output note that was not stored still stamps the fee, never the own action', () => {
    const s = stores();
    recordSameChainSwap({ ...base, noteStored: false }, s.sink);
    expect(s.fees).toHaveLength(1);
    expect(s.actions).toHaveLength(0);
  });

  test('no hash writes nothing; a zero or malformed fee writes no fee row', () => {
    const s = stores();
    recordSameChainSwap({ ...base, txHash: null }, s.sink);
    expect(s.fees.length + s.actions.length).toBe(0);
    recordSameChainSwap({ ...base, feeAmount: '0' }, s.sink);
    recordSameChainSwap({ ...base, feeAmount: 'nope' }, s.sink);
    expect(s.fees).toHaveLength(0);
    expect(s.actions).toHaveLength(2);
  });
});

describe('swap fee rows', () => {
  test('a swap fee round-trips and is never withdrawal ownership evidence', async () => {
    const { parseWithdrawFees, toWithdrawalTxHashSet } = await import('../withdraw-fees-core');
    const row = { txHash: '0xabc', feeAmount: '1', tokenAddress: '0xeeee', chainId: 1, timestamp: 1, kind: 'swap' };
    const parsed = parseWithdrawFees(JSON.stringify([row]));
    expect(parsed.map((r) => r.kind)).toEqual(['swap']);
    expect(toWithdrawalTxHashSet(parsed).size).toBe(0);
  });
});
