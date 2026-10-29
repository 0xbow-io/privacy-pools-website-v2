// Relayed Stellar flows must not show the RPC the user's account next to the nullifiers the relayer
// spends: the SDK encodes every proof as a pool `transact` from that account and simulates it, so
// while relaying that build is skipped, and a relayed receipt is never looked up by its hash.
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
    async waitForTransactionReceipt(hash: string) { calls.push(['waitForTransactionReceipt', hash]); return { status: true, txHash: hash }; },
    async getEvents() { calls.push(['getEvents']); return []; },
  };
  return { calls, rpc };
}

describe('relayAwareRpc', () => {
  test("while relaying, the SDK's own transact encode never reaches the RPC", async () => {
    const sdk = await import('@privacy-pools-v2/stellar-sdk');
    let relaying = true;
    const { calls, rpc } = spyRpc();
    const wrapped = relayAwareRpc(rpc as unknown as StellarRpcInteractor, POOL, { relaying: () => relaying, confirmRelayed: () => null });
    const vault = sdk.createStellarPoolVaultInteractor(
      { rpcInteractor: wrapped, contractId: POOL, readSourcePublicKey: ACCOUNT },
      { walletInteractor: { getAccounts: async () => [ACCOUNT] } as never },
    );
    const encode = () => vault.encodeTransact(
      { a: hex(64), b: hex(128), c: hex(64) } as never,
      [['0x1'], ['0x2', '0x3'], ['0x4'], ['0x5'], ['0x6'], ['0x7'], ['0x8']] as never,
      { processor: STELLAR_TESTNET_CONTRACTS.relayContractId, data: '0x' } as never,
      [],
      STELLAR_TESTNET_CONTRACTS.nativeAssetContractId as never,
    );

    expect(await encode()).toBe(RELAYED_TRANSACT_PLACEHOLDER);
    expect(calls).toEqual([]);

    // Self-submitted (not relaying): the build goes out, with the user's account as source.
    relaying = false;
    expect(await encode()).toBe('xdr');
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 3)).toEqual(['buildTransaction', POOL, 'transact']);
    expect(calls[0].at(-1)).toBe(ACCOUNT);
  });

  test('other builds pass through while relaying', async () => {
    const { calls, rpc } = spyRpc();
    const wrapped = relayAwareRpc(rpc as unknown as StellarRpcInteractor, POOL, { relaying: () => true, confirmRelayed: () => null });
    expect(await wrapped.buildTransaction(STELLAR_TESTNET_CONTRACTS.keystoreContractId, 'set_auth_policy', [], ACCOUNT)).toBe('xdr');
    expect(await wrapped.buildTransaction(POOL, 'ragequit', [], ACCOUNT)).toBe('xdr');
    expect(calls.map((c) => c[2])).toEqual(['set_auth_policy', 'ragequit']);
  });

  test('a relayed receipt comes from the confirmer; an unknown hash is refused while relaying', async () => {
    let relaying = true;
    const { calls, rpc } = spyRpc();
    const confirmed = { status: true, txHash: '0xbeef', logs: [] };
    const wrapped = relayAwareRpc(rpc as unknown as StellarRpcInteractor, POOL, {
      relaying: () => relaying,
      confirmRelayed: (hash) => (hash === '0xbeef' ? Promise.resolve(confirmed as never) : null),
    });
    expect(await wrapped.waitForTransactionReceipt('0xbeef')).toBe(confirmed as never);
    await expect(wrapped.waitForTransactionReceipt('0xcafe')).rejects.toThrow(/relayed transaction/);
    expect(calls).toEqual([]);

    relaying = false;
    await wrapped.waitForTransactionReceipt('0xcafe');
    expect(calls).toEqual([['waitForTransactionReceipt', '0xcafe']]);
  });

  test('everything else is the underlying RPC', async () => {
    const { calls, rpc } = spyRpc();
    const wrapped = relayAwareRpc(rpc as unknown as StellarRpcInteractor, POOL, { relaying: () => true, confirmRelayed: () => null }) as unknown as typeof rpc;
    await wrapped.getEvents();
    expect(calls).toEqual([['getEvents']]);
  });
});
