// Relayed Stellar flows must not show the RPC the user's account next to the nullifiers the relayer
// spends: the SDK builds a proof's `transact` locally (unsimulated), a simulated transact build is
// skipped while relaying, and a relayed receipt is never looked up by its hash.
import { describe, expect, test } from 'bun:test';
import { Keypair } from '@stellar/stellar-sdk';

import { STELLAR_TESTNET_CONTRACTS } from '@/config/stellar-deployment';
import { RELAYED_TRANSACT_PLACEHOLDER, relayAwareRpc } from '@/services/stellar/stellar-relayer';
import type { StellarRpcInteractor } from '@/services/stellar/stellar-runtime';

const POOL = STELLAR_TESTNET_CONTRACTS.poolContractId;
const ACCOUNT = Keypair.random().publicKey();
const hex = (bytes: number) => `0x${'11'.repeat(bytes)}`;

function spyRpc() {
  const calls: unknown[][] = [];
  const rpc = {
    async buildTransaction(...args: unknown[]) { calls.push(['buildTransaction', ...args]); return 'xdr'; },
    async buildUnsimulatedTransaction(...args: unknown[]) { calls.push(['buildUnsimulatedTransaction', ...args]); return 'unsimulated'; },
    async waitForTransactionReceipt(hash: string) { calls.push(['waitForTransactionReceipt', hash]); return { status: true, txHash: hash }; },
    async getEvents() { calls.push(['getEvents']); return []; },
  };
  return { calls, rpc };
}

describe('relayAwareRpc', () => {
  test("the SDK builds a proof's transact locally, unsimulated: proving sends the RPC nothing", async () => {
    const sdk = await import('@privacy-pools-v2/stellar-sdk');
    const { calls, rpc } = spyRpc();
    const wrapped = relayAwareRpc(rpc as unknown as StellarRpcInteractor, POOL, () => false);
    const vault = sdk.createStellarPoolVaultInteractor(
      { rpcInteractor: wrapped, contractId: POOL, readSourcePublicKey: ACCOUNT },
      { walletInteractor: { getAccounts: async () => [ACCOUNT] } as never },
    );
    await vault.encodeTransact(
      { a: hex(64), b: hex(128), c: hex(64) } as never,
      [['0x1'], ['0x2', '0x3'], ['0x4'], ['0x5'], ['0x6'], ['0x7'], ['0x8']] as never,
      { processor: STELLAR_TESTNET_CONTRACTS.relayContractId, data: '0x' } as never,
      [],
      STELLAR_TESTNET_CONTRACTS.nativeAssetContractId as never,
    );
    // buildUnsimulatedTransaction is local (a placeholder sequence, no getAccount, no simulation).
    expect(calls.map((c) => c[0])).toEqual(['buildUnsimulatedTransaction']);
  });

  test('a transact build is skipped while relaying', async () => {
    const { calls, rpc } = spyRpc();
    const wrapped = relayAwareRpc(rpc as unknown as StellarRpcInteractor, POOL, () => true);
    expect(await wrapped.buildTransaction(POOL, 'transact', [], ACCOUNT)).toBe(RELAYED_TRANSACT_PLACEHOLDER);
    expect(calls).toEqual([]);
  });

  test('other builds pass through while relaying', async () => {
    const { calls, rpc } = spyRpc();
    const wrapped = relayAwareRpc(rpc as unknown as StellarRpcInteractor, POOL, () => true);
    expect(await wrapped.buildTransaction(STELLAR_TESTNET_CONTRACTS.keystoreContractId, 'set_auth_policy', [], ACCOUNT)).toBe('xdr');
    expect(await wrapped.buildTransaction(POOL, 'ragequit', [], ACCOUNT)).toBe('xdr');
    expect(calls.map((c) => c[2])).toEqual(['set_auth_policy', 'ragequit']);
  });

  test('a receipt is never looked up by hash while relaying', async () => {
    let relaying = true;
    const { calls, rpc } = spyRpc();
    const wrapped = relayAwareRpc(rpc as unknown as StellarRpcInteractor, POOL, () => relaying);
    await expect(wrapped.waitForTransactionReceipt('0xcafe')).rejects.toThrow(/relayed transaction/);
    expect(calls).toEqual([]);

    relaying = false;
    await wrapped.waitForTransactionReceipt('0xcafe');
    expect(calls).toEqual([['waitForTransactionReceipt', '0xcafe']]);
  });

  test('everything else is the underlying RPC', async () => {
    const { calls, rpc } = spyRpc();
    const wrapped = relayAwareRpc(rpc as unknown as StellarRpcInteractor, POOL, () => true) as unknown as typeof rpc;
    await wrapped.getEvents();
    expect(calls).toEqual([['getEvents']]);
  });
});
