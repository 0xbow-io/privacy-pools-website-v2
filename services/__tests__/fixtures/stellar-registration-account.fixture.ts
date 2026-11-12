import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { Account, Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import type { StellarWalletProvider } from '@privacy-pools-v2/stellar-sdk';

mock.module('react-native', () => ({ Platform: { OS: 'web' } }));
const runtime = await import('../../stellar/stellar-runtime');
const { stellarAccount: account } = await import('../../stellar/stellar-account');
const { stellarRegistrationPrompts: prompts } = await import('../../stellar/stellar-registration-prompt');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const address = Keypair.random().publicKey();
const xdr = new TransactionBuilder(new Account(address, '0'), { fee: '100', networkPassphrase: Networks.TESTNET }).setTimeout(60).build().toXDR();
let state: { alreadyRegistered: boolean; keystoreCalldata: object | null; viewingKeyCalldata: object | null };
let provider: StellarWalletProvider;
let signed: ReturnType<typeof deferred<string>>;
let signing: ReturnType<typeof deferred<void>>;
let opened: ReturnType<typeof deferred<void>>;
let visible: boolean;
let broadcasts: number;
let failRead: boolean;
let registrationReads: number;
let detach: () => void;

beforeEach(async () => {
  state = { alreadyRegistered: false, keystoreCalldata: {}, viewingKeyCalldata: {} };
  signed = deferred(); signing = deferred(); opened = deferred(); broadcasts = 0; failRead = false; registrationReads = 0;
  const session = {
    prepareRegisterKeystore: async () => { registrationReads++; if (failRead) throw new Error('RPC unavailable'); return state; },
    executeRegisterKeystore: async () => {
      await provider.signTransaction(xdr, { networkPassphrase: Networks.TESTNET });
      broadcasts++;
      state = { alreadyRegistered: true, keystoreCalldata: null, viewingKeyCalldata: null };
    },
  };
  spyOn(runtime, 'createIndexedRpcInteractor').mockReturnValue({} as never);
  spyOn(runtime, 'createNoRelayerInteractor').mockReturnValue({} as never);
  spyOn(runtime, 'loadStellarSdk').mockResolvedValue({
    FreighterWalletInteractor: class { async signKeyDerivationMessage() { return 'signature'; } },
    SorobanRPCInteractor: class {},
    StellarCryptoService: class { deriveKeysFromSignature() { return { privateNullifyingKey: '0x1' }; } },
    StellarPoolSessionBuilder: { create: async (options: { walletInteractor: { provider: StellarWalletProvider } }) => { provider = options.walletInteractor.provider; return session; } },
  } as never);
  account.bind(address, {
    getAddress: async () => address,
    getNetworkPassphrase: async () => Networks.TESTNET,
    signTransaction: async () => { signing.resolve(); return signed.promise; },
  } as StellarWalletProvider);
  detach = prompts.attach((prompt) => { visible = !!prompt; if (prompt && !prompt.pending) opened.resolve(); }, () => true);
  await account.ensureSession();
});

afterEach(() => { detach(); account.bind(null, null); mock.restore(); });

test('account registration waits for consent and closes after confirmation', async () => {
  const done = account.ensureCanReceive();
  await opened.promise;
  expect(broadcasts).toBe(0);
  prompts.approve();
  await signing.promise;
  signed.resolve(xdr);
  await done;
  expect(broadcasts).toBe(1);
  expect(account.getSnapshot().registrationStatus).toBe('compatible');
  expect(visible).toBe(false);
});

for (const change of ['close', 'account']) {
  test(`${change} during signing prevents broadcast and closes the dialog`, async () => {
    const done = account.ensureCanReceive();
    await opened.promise;
    prompts.approve();
    await signing.promise;
    if (change === 'close') {
      // An earlier leg landed before the outstanding wallet signature.
      state = { alreadyRegistered: false, keystoreCalldata: null, viewingKeyCalldata: {} };
      prompts.cancel();
    } else account.bind(Keypair.random().publicKey(), null);
    signed.resolve(xdr);
    await expect(done).rejects.toThrow(change === 'close' ? 'registration cancelled' : 'account changed');
    expect(broadcasts).toBe(0);
    expect(visible).toBe(false);
    expect(account.getSnapshot().registrationStatus).toBe(change === 'close' ? 'partial' : undefined);
  });
}

test('status reads reflect partial setup and retain it when RPC fails', async () => {
  state = { alreadyRegistered: false, keystoreCalldata: null, viewingKeyCalldata: {} };
  await account.checkRegistration();
  expect(account.getSnapshot().registrationStatus).toBe('partial');
  failRead = true;
  await expect(account.checkRegistration()).rejects.toThrow('RPC unavailable');
  expect(account.getSnapshot().registrationStatus).toBe('partial');
  expect(broadcasts).toBe(0);
  expect(visible).toBe(false);
});


test('a compatible registration is reused, but cancellation and another account still refuse', async () => {
  state = { alreadyRegistered: true, keystoreCalldata: null, viewingKeyCalldata: null };
  await account.ensureCanReceive();
  const readsAfterConfirmation = registrationReads;
  await account.ensureCanReceive();
  expect(registrationReads).toBe(readsAfterConfirmation);
  await expect(account.ensureCanReceive({ shouldContinue: () => false })).rejects.toThrow('Superseded');
  const other = Keypair.random().publicKey();
  account.bind(other, {
    getAddress: async () => other,
    getNetworkPassphrase: async () => Networks.TESTNET,
    signTransaction: async () => { throw new Error('must not sign'); },
  } as StellarWalletProvider);
  failRead = true;
  await expect(account.ensureCanReceive()).rejects.toThrow('RPC unavailable');
  expect(broadcasts).toBe(0);
});
