import { Buffer } from 'buffer';
import { expect, test, spyOn } from 'bun:test';
import { nativeToScVal, rpc, StrKey, scValToNative } from '@stellar/stellar-sdk';
import { fetchStellarDepositVettingFee } from '@/services/stellar/stellar-fee-feed';
import { readStellarDepositVettingFee, STELLAR_FEE_INTERVAL_MS } from '@/services/stellar-fee-estimate';
import { STELLAR_TESTNET_CONTRACTS } from '@/config/stellar-deployment';
import { maxShieldAmountWei } from '@/services/wallet-tx-fees';
import { stellarBalanceFromAccount } from '@/hooks/use-stellar-balance';

test('deposit Max preserves Stellar reserves and liabilities and covers the on-top vetting fee', () => {
  const { spendable } = stellarBalanceFromAccount({ subentry_count: 2, num_sponsoring: 1, num_sponsored: 0,
    balances: [{ asset_type: 'native', balance: '1000', selling_liabilities: '10' }] });
  expect(spendable).toBe(9_865_000_000n);
  for (const vettingFeeBps of [0, 100, 10_000]) {
    const max = maxShieldAmountWei({ balanceWei: spendable, payIsNative: false, gasPriceWei: null, vettingFeeBps });
    expect(max + max * BigInt(vettingFeeBps) / 10_000n).toBeLessThanOrEqual(spendable);
    expect(spendable - max - max * BigInt(vettingFeeBps) / 10_000n).toBeLessThanOrEqual(1n);
  }
});

test('deposit config uses a neutral source and validates on-chain basis points', async () => {
  let bps = 100;
  const simulate = spyOn(rpc.Server.prototype, 'simulateTransaction').mockImplementation(async transaction => {
    if (!('source' in transaction)) throw new Error('Unexpected fee bump');
    expect(transaction.source).toBe(StrKey.encodeEd25519PublicKey(Buffer.alloc(32)));
    expect(transaction.operations).toHaveLength(1);
    const operation = transaction.operations[0];
    if (operation.type !== 'invokeHostFunction') throw new Error('Unexpected operation');
    const call = operation.func.invokeContract();
    expect(call.functionName().toString()).toBe('get_asset_config');
    expect(call.args().map(scValToNative)).toEqual([STELLAR_TESTNET_CONTRACTS.nativeAssetContractId]);
    return { id: '1', latestLedger: 1, events: [], transactionData: {}, minResourceFee: '0',
      result: { auth: [], retval: nativeToScVal({ vetting_fee_bps: bps }) } } as never;
  });
  try {
    expect(await fetchStellarDepositVettingFee()).toBe(100);
    bps = 10_001;
    await expect(fetchStellarDepositVettingFee()).rejects.toThrow('Invalid Stellar vetting fee');
  } finally { simulate.mockRestore(); }
});

test('deposit config is cache-only, expires, and survives a transient refresh failure', () => {
  expect(readStellarDepositVettingFee({ status: 'empty' })).toBeNull();
  expect(readStellarDepositVettingFee({ status: 'ready', data: 100, at: 0 }, 1)).toBe(100);
  const failed = { status: 'error' as const, data: 100, dataAt: 0, at: 60_000, error: new Error('offline') };
  expect(readStellarDepositVettingFee(failed, 60_000)).toBe(100);
  expect(readStellarDepositVettingFee(failed, 2 * STELLAR_FEE_INTERVAL_MS)).toBeNull();
});
