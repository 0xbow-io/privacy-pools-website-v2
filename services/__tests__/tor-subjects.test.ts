import { describe, expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import { toBase58, toBase64 } from '@mysten/sui/utils';
import { suiSubject } from '@/services/sui-tor-subject';
import { lifiStatusSubject } from '@/services/tor-groups';

const HASH = `0x${'ab'.repeat(32)}`;

describe('what a request is about, read before it is serialized away', () => {
  test('a Sui transaction the wallet executes or dry-runs is about its signer; a lookup about its digest', async () => {
    const sender = `0x${'5'.repeat(64)}`;
    const tx = new Transaction();
    tx.setSender(sender);
    tx.setGasPrice(1000);
    tx.setGasBudget(10_000_000);
    tx.setGasPayment([{ objectId: `0x${'1'.repeat(64)}`, version: '1', digest: toBase58(new Uint8Array(32)) }]);
    const bytes = toBase64(await tx.build());
    for (const method of ['sui_executeTransactionBlock', 'sui_dryRunTransactionBlock']) {
      expect(suiSubject('', JSON.stringify({ method, params: [bytes, []] }))).toEqual({ account: sender });
    }
    expect(suiSubject('', JSON.stringify({ method: 'sui_executeTransactionBlock', params: ['not bcs'] }))).toEqual({ identifying: true });
    expect(suiSubject('', JSON.stringify({ method: 'sui_getTransactionBlock', params: ['Digest58'] }))).toEqual({ transaction: 'Digest58' });
    expect(suiSubject('', JSON.stringify({ method: 'sui_getObject', params: [`0x${'1'.repeat(64)}`] }))).toEqual({});
  });

  test('a LI.FI status query is about the transaction it names', () => {
    expect(lifiStatusSubject(`https://li.quest/v1/status?txHash=${HASH}&fromChain=1`)).toEqual({ transaction: HASH });
    expect(lifiStatusSubject('https://li.quest/v1/status?bridge=x')).toEqual({ identifying: true });
    expect(lifiStatusSubject('https://li.quest/v1/quote?fromChain=1')).toEqual({});
  });
});
