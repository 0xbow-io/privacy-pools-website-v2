import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BASE_APP_NOTICE_BODY, BASE_APP_NOTICE_TITLE, BASE_APP_USE_ANOTHER_WALLET, BaseAppCannotSignError, isBaseAppCannotSign,
} from '../base-app-passkey-choice';
import { isCoinbaseV4Failed, signTypedDataWithCoinbaseFallback } from '../coinbase-typed-data-fallback';
import { isCoinbaseWalletIdentity, isWalletConnectConnector } from '../wallet-signature-timeout';

const EOA = '0x1b11d9561c834ef7206530f25d991b510accb40e' as const;
const typedData = {
  domain: { name: 'Privacy Pools', version: '1', chainId: 1 },
  types: { Derive: [{ name: 'purpose', type: 'string' }, { name: 'addressHash', type: 'bytes32' }] },
  primaryType: 'Derive',
  message: { purpose: 'x', addressHash: `0x${'00'.repeat(32)}` },
} as never;
const notEnoughFunds = () => Promise.reject(new Error('Error generating message. Please make sure you have enough funds'));
const failingProvider = { request: notEnoughFunds };
const providerSrc = readFileSync(join(__dirname, '../../components/sdk-provider.tsx'), 'utf8');
const modalSrc = readFileSync(join(__dirname, '../../components/seed-derivation-modal-provider.tsx'), 'utf8');
const catchBranch = () => {
  const start = providerSrc.indexOf('} catch (cbErr) {');
  expect(start).toBeGreaterThan(0);
  return providerSrc.slice(start, providerSrc.indexOf('throw new BaseAppCannotSignError();', start));
};

describe('Base app signer: the only message is to use another wallet', () => {
  test('copy', () => {
    expect(BASE_APP_NOTICE_TITLE).toBe("Base app can't sign in here yet");
    expect(BASE_APP_NOTICE_BODY).toBe('Please use another wallet.');
    expect(BASE_APP_USE_ANOTHER_WALLET).toBe('Use another wallet');
    for (const s of [BASE_APP_NOTICE_TITLE, BASE_APP_NOTICE_BODY, BASE_APP_USE_ANOTHER_WALLET]) expect(s).not.toMatch(/—/);
    expect(isBaseAppCannotSign(new BaseAppCannotSignError())).toBe(true);
  });

  test('the first failed sign shows the notice (no second v3 tap, no passkey)', async () => {
    const tap1 = await signTypedDataWithCoinbaseFallback({ signV4: notEnoughFunds as never, coinbaseInApp: true, useV3: false, provider: failingProvider, address: EOA, typedData }).catch((e) => e);
    expect(isCoinbaseV4Failed(tap1)).toBe(true);
    const branch = catchBranch();
    expect(branch).toContain('if (!isCoinbaseV4Failed(cbErr) && !isCoinbaseAppCannotSign(cbErr)) throw cbErr;');
    expect(branch).toContain('setBaseAppRefused(');
    for (const s of ['runPasskeyBranch', 'setPasskeyActive(true)', 'setRefusedSigners(', 'coinbaseV4FailedRef.current.add']) expect(branch).not.toContain(s);
    expect(providerSrc).not.toContain('coinbasePasskeyFallbackApplies');
  });

  test('no device sign-in, copy link or sign-with-wallet variants remain', () => {
    for (const s of ['seed-derivation-base-use-passkey', 'seed-derivation-base-copy-link', 'seed-derivation-base-sign-with-wallet', 'BASE_APP_DEVICE_ON_MESSAGE', 'returningDismissedFor']) {
      expect(modalSrc).not.toContain(s);
    }
    expect(modalSrc).toContain('testID="seed-derivation-base-another-wallet"');
    expect(modalSrc).toContain('!passkeyActive && !pending && !baseAppCannotSign');
    expect(providerSrc).not.toContain('baseAppSigner');
  });

  test('Use another wallet disconnects and reopens the picker', () => {
    const start = modalSrc.indexOf('const switchWallet = useCallback(');
    const body = modalSrc.slice(start, modalSrc.indexOf('}, [', start));
    expect(body).toContain('await disconnectAsync()');
    expect(body).toContain('walletPicker.open()');
  });

  test('a Base refusal does not follow the address to another connection', () => {
    expect(providerSrc).toMatch(/setBaseAppRefused\(\(prev\) => \(prev\.size \? new Set\(\) : prev\)\);\n\s+\}, \[address, activeConnector\]\);/);
  });

  test('the Coinbase extension is not a Base signer: WalletConnect peers and the in-app browser only', () => {
    expect(providerSrc).toContain('|| (isWalletConnectConnector(connector) && isCoinbaseWalletIdentity(await resolveWalletIdentity(connector)));');
    for (const peerName of ['Base', 'Base App', 'base wallet', 'Coinbase Wallet']) {
      expect(isCoinbaseWalletIdentity({ id: 'walletConnect', peerName })).toBe(true);
    }
    expect(isCoinbaseWalletIdentity({ id: 'walletConnect', peerName: 'Basel Wallet' })).toBe(false);
    expect(isWalletConnectConnector({ id: 'walletConnect' })).toBe(true);
    expect(isWalletConnectConnector({ id: 'coinbaseWalletSDK' })).toBe(false);
  });

  test('non-Base wallets are unchanged', async () => {
    expect(isCoinbaseWalletIdentity({ id: 'walletConnect', peerName: 'MetaMask Wallet' })).toBe(false);
    const err = await signTypedDataWithCoinbaseFallback({ signV4: notEnoughFunds as never, coinbaseInApp: false, useV3: false, provider: failingProvider, address: EOA, typedData }).catch((e) => e);
    expect(isCoinbaseV4Failed(err)).toBe(false);
  });

  test('a Base app WalletConnect timeout names the Base app', async () => {
    const { coinbaseWalletLabel } = await import('../wallet-signature-timeout');
    expect(coinbaseWalletLabel({ id: 'walletConnect', peerName: 'Base' })).toBe('Base app');
    expect(coinbaseWalletLabel({ id: 'coinbaseWalletSDK' })).toBe('Coinbase Wallet');
  });

  test('stale-connector and reconnecting errors pass through the Coinbase v4 wrapper', async () => {
    for (const msg of ['u.connector.getChainId is not a function', 'Connector unavailable while reconnecting']) {
      const err = await signTypedDataWithCoinbaseFallback({ signV4: () => Promise.reject(new Error(msg)), coinbaseInApp: true, useV3: false, provider: failingProvider, address: EOA, typedData }).catch((e) => e);
      expect(isCoinbaseV4Failed(err)).toBe(false);
      expect((err as Error).message).toBe(msg);
    }
  });
});
