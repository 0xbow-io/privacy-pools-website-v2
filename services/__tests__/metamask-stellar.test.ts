// MetaMask as a Stellar signer: the adapter is faked at its public interface (the shapes come
// from @metamask/connect-stellar's own .d.ts, checked by tsc through MetaMaskStellarApi).
// The adapter is mainnet only, so the app's testnet passphrase must read as a clear mismatch.

import { describe, expect, test } from 'bun:test';

import {
  metaMaskNetworkMismatchMessage,
  metaMaskSigner,
  watchMetaMask,
  type MetaMaskStellarApi,
} from '@/services/stellar/metamask-stellar';
import {
  readStellarWalletKind,
  STELLAR_WALLET_KIND_KEY,
  writeStellarWalletKind,
} from '@/services/stellar/stellar-wallet-choice';
import { setStellarCopyWallet, stellarErrorMessage, describeStellarStage, stellarUnlockErrorTitle } from '@/services/stellar/stellar-copy';

const A = `G${'A'.repeat(55)}`;
const B = `G${'B'.repeat(55)}`;
const TESTNET = 'Test SDF Network ; September 2015';
const PUBNET = 'Public Global Stellar Network ; September 2015';

type Listener = (data: unknown) => void;

function fakeAdapter(opts: { passphrase?: string; signError?: { message: string }; throwUnknownNetwork?: boolean } = {}) {
  const listeners = new Map<string, Set<Listener>>();
  const signed: { xdr: string; networkPassphrase?: string }[] = [];
  const adapter = {
    requestAccess: async () => ({ address: A }),
    getAddress: async () => ({ address: A }),
    getNetwork: async () => ({ network: 'PUBLIC', networkPassphrase: opts.passphrase ?? PUBNET }),
    isAllowed: async () => ({ isAllowed: true }),
    disconnect: async () => ({}),
    signTransaction: async (xdr: string, o?: { networkPassphrase?: string }) => {
      signed.push({ xdr, networkPassphrase: o?.networkPassphrase });
      if (opts.throwUnknownNetwork) throw new Error(`Unknown network passphrase: ${o?.networkPassphrase}`);
      if (opts.signError) return { signedTxXdr: '', signerAddress: A, error: opts.signError as never };
      return { signedTxXdr: `signed:${xdr}`, signerAddress: A };
    },
    on: (event: string, l: Listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(l);
    },
    off: (event: string, l: Listener) => void listeners.get(event)?.delete(l),
  } satisfies MetaMaskStellarApi;
  const emit = (event: string, data?: unknown) => listeners.get(event)?.forEach((l) => l(data));
  const count = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
  return { adapter: adapter as MetaMaskStellarApi, emit, signed, count };
}

describe('metaMaskSigner', () => {
  test('reads the address and network from the adapter', async () => {
    const { adapter } = fakeAdapter();
    const signer = metaMaskSigner(adapter);
    expect(await signer.getAddress()).toBe(A);
    expect(await signer.getNetworkPassphrase()).toBe(PUBNET);
  });

  test('signs when the app network is the wallet network', async () => {
    const { adapter, signed } = fakeAdapter();
    const signer = metaMaskSigner(adapter);
    expect(await signer.signTransaction('AAAA', { networkPassphrase: PUBNET })).toBe('signed:AAAA');
    expect(signed).toEqual([{ xdr: 'AAAA', networkPassphrase: PUBNET }]);
  });

  test('the testnet app says MetaMask is mainnet only, before asking the wallet to sign', async () => {
    const { adapter, signed } = fakeAdapter();
    const signer = metaMaskSigner(adapter);
    await expect(signer.signTransaction('AAAA', { networkPassphrase: TESTNET })).rejects.toThrow(
      'MetaMask supports Stellar mainnet only, this app is on Stellar Testnet.',
    );
    expect(signed).toEqual([]);
  });

  test("the adapter's own 'Unknown network passphrase' throw becomes the same sentence", async () => {
    // getNetwork errors (session not restored yet), so the adapter is asked and throws.
    const { adapter } = fakeAdapter({ throwUnknownNetwork: true });
    const broken = { ...adapter, getNetwork: async () => ({ network: '', networkPassphrase: '', error: { code: -3, message: 'not connected' } }) } as MetaMaskStellarApi;
    await expect(metaMaskSigner(broken).signTransaction('AAAA', { networkPassphrase: TESTNET })).rejects.toThrow(
      metaMaskNetworkMismatchMessage(),
    );
  });

  test('a wallet-side refusal is thrown, not returned', async () => {
    const { adapter } = fakeAdapter({ signError: { message: 'User rejected the request' } });
    await expect(metaMaskSigner(adapter).signTransaction('AAAA', { networkPassphrase: PUBNET })).rejects.toThrow('User rejected the request');
  });
});

describe('watchMetaMask', () => {
  test('reports an account switch and a network switch, then stops listening', () => {
    const { adapter, emit, count } = fakeAdapter();
    const events: string[] = [];
    const watcher = watchMetaMask(adapter, { address: A, passphrase: PUBNET }, {
      change: ({ address, passphrase }) => events.push(`${address[1]}:${passphrase === TESTNET ? 'test' : 'pub'}`),
      revoked: () => events.push('revoked'),
    });
    emit('accountsChanged', A);
    emit('accountsChanged', B);
    emit('networkChanged', { network: 'TESTNET', networkPassphrase: TESTNET });
    emit('networkChanged', { network: 'TESTNET', networkPassphrase: TESTNET });
    expect(events).toEqual(['B:pub', 'B:test']);
    watcher.stop();
    expect(count()).toBe(0);
    emit('accountsChanged', A);
    expect(events).toHaveLength(2);
  });

  test('a disconnect or a cleared account is revoked once, and a later account reconnects', () => {
    const { adapter, emit } = fakeAdapter();
    const events: string[] = [];
    watchMetaMask(adapter, { address: A, passphrase: PUBNET }, {
      change: ({ address }) => events.push(`change:${address[1]}`),
      revoked: () => events.push('revoked'),
    });
    emit('disconnect');
    emit('accountsChanged', null);
    emit('accountsChanged', B);
    expect(events).toEqual(['revoked', 'change:B']);
  });
});

describe('wallet choice persistence', () => {
  function memoryStore() {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  }

  test('a browser from before the choice existed was using Freighter', () => {
    expect(readStellarWalletKind(memoryStore())).toBe('freighter');
  });

  test('MetaMask is remembered next to the connected flag, and Freighter clears it', () => {
    const store = memoryStore();
    writeStellarWalletKind('metamask', store);
    expect(store.map.get(STELLAR_WALLET_KIND_KEY)).toBe('metamask');
    expect(readStellarWalletKind(store)).toBe('metamask');
    writeStellarWalletKind('freighter', store);
    expect(readStellarWalletKind(store)).toBe('freighter');
    expect(store.map.size).toBe(0);
  });

  test('unavailable or throwing storage falls back to Freighter', () => {
    const throwing = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(readStellarWalletKind(throwing)).toBe('freighter');
    expect(() => writeStellarWalletKind('metamask', throwing)).not.toThrow();
  });
});

describe('wallet-neutral flow copy and MetaMask-specific network guidance', () => {
  test('flow wording stays wallet-neutral by default', () => {
    expect(describeStellarStage('signing')).toBe('Submitting (approve in your wallet)...');
    expect(stellarUnlockErrorTitle(new Error('User declined access'))).toBe('Sign-in cancelled in your wallet.');
    expect(stellarErrorMessage('Freighter network mismatch')).toBe('Your wallet is on another network. Switch it to Testnet and try again.');
  });

  test('MetaMask retains neutral flow copy and explains the mainnet-only limitation', () => {
    setStellarCopyWallet('metamask');
    try {
      expect(describeStellarStage('signing')).toBe('Submitting (approve in your wallet)...');
      expect(stellarUnlockErrorTitle(new Error('User rejected'))).toBe('Sign-in cancelled in your wallet.');
      expect(stellarErrorMessage('Unknown network passphrase: Test SDF Network ; September 2015')).toBe(
        'MetaMask supports Stellar mainnet only, this app is on Stellar Testnet.',
      );
      expect(stellarErrorMessage(metaMaskNetworkMismatchMessage())).toBe(metaMaskNetworkMismatchMessage());
    } finally {
      setStellarCopyWallet('freighter');
    }
  });
});
