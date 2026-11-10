// Stellar txTooLate: the SDK builds every Soroban call with a 30 s validity
// window (DEFAULT_TX_TIMEOUT_SECONDS) BEFORE the Freighter popup opens, so the
// time a person spends reading and approving the popup counts against it, and
// the second keystore registration transaction (built together with the first)
// also waits on the first one's confirmation. The window now starts when the
// wallet is asked to sign.
//
// Fixtures come from the real producers: the SDK's own SorobanRPCInteractor
// builds the call transaction (only its account read is stubbed) and the SDK's
// FreighterWalletInteractor signs the key derivation message.

import { describe, expect, test } from 'bun:test';
import { Account, Keypair, TransactionBuilder } from '@stellar/stellar-sdk';

import { STELLAR_TESTNET_CONTRACTS, STELLAR_TESTNET_NETWORK } from '@/config/stellar-deployment';
import {
  STELLAR_SIGNING_WINDOW_SECONDS,
  refreshSigningWindow,
  withSigningWindow,
} from '@/services/stellar/stellar-signing-window';

const passphrase = STELLAR_TESTNET_NETWORK.networkPassphrase;
const keypair = Keypair.random();

/** An unsigned pool call exactly as the SDK builds it before simulation. */
async function sdkCallXdr(): Promise<string> {
  const sdk = await import('@privacy-pools-v2/stellar-sdk');
  const rpc = new sdk.SorobanRPCInteractor({ rpcUrl: 'https://rpc.invalid', networkPassphrase: passphrase });
  // The account read is the only network call buildCallTransaction makes.
  (rpc as unknown as { server: { getAccount: () => Promise<Account> } }).server = {
    getAccount: async () => new Account(keypair.publicKey(), '4242'),
  };
  const build = (rpc as unknown as {
    buildCallTransaction: (c: string, m: string, a: unknown[], s: string, o: number) => Promise<{ toXDR(): string }>;
  }).buildCallTransaction.bind(rpc);
  const tx = await build(STELLAR_TESTNET_CONTRACTS.poolContractId, 'deposit', [], keypair.publicKey(), 1);
  return tx.toXDR();
}

function maxTimeOf(xdr: string): number {
  const tx = TransactionBuilder.fromXDR(xdr, passphrase) as unknown as { timeBounds?: { maxTime: string } };
  return Number(tx.timeBounds?.maxTime ?? 0);
}

function burner() {
  const signed: string[] = [];
  return {
    signed,
    signer: {
      async getAddress() { return keypair.publicKey(); },
      async getNetworkPassphrase() { return passphrase; },
      async signTransaction(xdr: string, opts: { networkPassphrase: string }) {
        signed.push(xdr);
        const tx = TransactionBuilder.fromXDR(xdr, opts.networkPassphrase);
        tx.sign(keypair);
        return tx.toXDR();
      },
    },
  };
}

describe('Stellar signing window', () => {
  test('the SDK call transaction expires 30 s after it is built', async () => {
    const before = Math.floor(Date.now() / 1000);
    const max = maxTimeOf(await sdkCallXdr());
    expect(max).toBeGreaterThanOrEqual(before + 29);
    expect(max).toBeLessThanOrEqual(before + 31);
  });

  test('a call signed a minute after it was built is still valid when it reaches the network', async () => {
    const xdr = await sdkCallXdr();
    const builtMax = maxTimeOf(xdr);
    // The popup opens 60 s later: past the SDK's own expiry.
    const askedAt = builtMax + 30;
    const refreshed = await refreshSigningWindow(xdr, askedAt);
    expect(maxTimeOf(refreshed)).toBe(askedAt + STELLAR_SIGNING_WINDOW_SECONDS);
    // Nothing else moves: same source, sequence, fee and operation.
    const a = TransactionBuilder.fromXDR(xdr, passphrase) as unknown as { source: string; sequence: string; fee: string; operations: unknown[] };
    const b = TransactionBuilder.fromXDR(refreshed, passphrase) as unknown as typeof a;
    expect(b.source).toBe(a.source);
    expect(b.sequence).toBe(a.sequence);
    expect(b.fee).toBe(a.fee);
    expect(JSON.stringify(b.operations)).toBe(JSON.stringify(a.operations));
  });

  test('never shortens a window', async () => {
    const xdr = await sdkCallXdr();
    expect(await refreshSigningWindow(xdr, maxTimeOf(xdr) - 10_000)).toBe(xdr);
  });

  test('the wallet is handed the refreshed transaction', async () => {
    const xdr = await sdkCallXdr();
    const { signed, signer } = burner();
    const askedAt = maxTimeOf(xdr) + 30;
    const wrapped = withSigningWindow(signer, () => askedAt * 1000);
    await wrapped.signTransaction(xdr, { networkPassphrase: passphrase });
    expect(maxTimeOf(signed[0])).toBe(askedAt + STELLAR_SIGNING_WINDOW_SECONDS);
  });

  test('the key derivation message is signed byte for byte (the account keys depend on it)', async () => {
    const sdk = await import('@privacy-pools-v2/stellar-sdk');
    const rpcInteractor = new sdk.SorobanRPCInteractor({ rpcUrl: 'https://rpc.invalid', networkPassphrase: passphrase });
    const plain = burner();
    const wrapped = burner();
    const sign = (provider: ReturnType<typeof burner>['signer']) => new sdk.FreighterWalletInteractor({
      provider, networkPassphrase: passphrase, rpcInteractor,
    }).signKeyDerivationMessage(keypair.publicKey());
    const expected = await sign(plain.signer);
    const actual = await sign(withSigningWindow(wrapped.signer, () => Date.now() + 3_600_000) as ReturnType<typeof burner>['signer']);
    expect(actual).toBe(expected);
    expect(wrapped.signed[0]).toBe(plain.signed[0]);
  });
});
