import { describe, expect, test } from 'bun:test';
import { Transaction } from '@mysten/sui/transactions';
import { toBase58, toBase64 } from '@mysten/sui/utils';
import { Account, Address, Keypair, Operation, StrKey, TransactionBuilder, xdr } from '@stellar/stellar-sdk';
import { STELLAR_TESTNET_NETWORK } from '@/config/stellar-deployment';
import { sorobanSubject } from '@/services/stellar/stellar-runtime';
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

  test('a Soroban account read, balance read, or transaction is about its account; a lookup about its hash', async () => {
    const account = Keypair.random().publicKey();
    const accountKey = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(account).xdrAccountId() }));
    const balanceKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
      contract: new Address(StrKey.encodeContract(Buffer.alloc(32))).toScAddress(),
      key: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('Balance'), new Address(account).toScVal()]),
      durability: xdr.ContractDataDurability.persistent(),
    }));
    const poolKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
      contract: new Address(StrKey.encodeContract(Buffer.alloc(32))).toScAddress(),
      key: xdr.ScVal.scvSymbol('Root'),
      durability: xdr.ContractDataDurability.persistent(),
    }));
    const transaction = new TransactionBuilder(new Account(account, '1'), { fee: '100', networkPassphrase: STELLAR_TESTNET_NETWORK.networkPassphrase })
      .addOperation(Operation.bumpSequence({ bumpTo: '2' })).setTimeout(0).build().toXDR();
    const read = (keys: InstanceType<typeof xdr.LedgerKey>[]) => sorobanSubject({ method: 'getLedgerEntries', params: { keys: keys.map((key) => key.toXDR('base64')) } });
    expect(await read([accountKey])).toEqual({ account });
    expect(await read([poolKey, balanceKey])).toEqual({ account });
    expect(await read([poolKey])).toEqual({});
    for (const method of ['sendTransaction', 'simulateTransaction']) {
      expect(await sorobanSubject({ method, params: { transaction } })).toEqual({ account });
    }
    expect(await sorobanSubject({ method: 'getTransaction', params: { hash: 'ab'.repeat(32) } })).toEqual({ transaction: 'ab'.repeat(32) });
    expect(await sorobanSubject({ method: 'simulateTransaction', params: { transaction: 'not xdr' } })).toEqual({ identifying: true });
  });

  test('a LI.FI status query is about the transaction it names', () => {
    expect(lifiStatusSubject(`https://li.quest/v1/status?txHash=${HASH}&fromChain=1`)).toEqual({ transaction: HASH });
    expect(lifiStatusSubject('https://li.quest/v1/status?bridge=x')).toEqual({ identifying: true });
    expect(lifiStatusSubject('https://li.quest/v1/quote?fromChain=1')).toEqual({});
  });
});
