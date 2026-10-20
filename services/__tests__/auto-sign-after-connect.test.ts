import { beforeEach, describe, expect, test } from 'bun:test';
import { isCoinbaseWalletIdentity, resolveWalletIdentity } from '../wallet-signature-timeout';

import {
  AUTO_SIGN_ARM_TTL_MS,
  armAutoSignAfterConnect,
  disarmAutoSignAfterConnect,
  peekAutoSignArm,
  shouldAutoSignAfterConnect,
  subscribeAutoSignArm,
  takeAutoSignArm,
  type AutoSignInputs,
} from '../auto-sign-after-connect';

const ADDR = '0xAbCdEf0000000000000000000000000000000001';

function inputs(over: Partial<AutoSignInputs> = {}): AutoSignInputs {
  return {
    arm: { address: ADDR.toLowerCase(), armedAt: 1_000 },
    now: 2_000,
    status: 'connected',
    address: ADDR,
    identityMode: 'wallet',
    nonEvmChain: false,
    keysReady: false,
    isInitializing: false,
    passkeyActive: false,
    pageVisible: true,
    smartWalletProbeSettled: true,
    isSmartWallet: false,
    ...over,
  };
}

describe('shouldAutoSignAfterConnect', () => {
  test('a fresh user connect leads to a sign request', () => {
    expect(shouldAutoSignAfterConnect(inputs())).toBe('sign');
  });

  test('no arm (page-load auto-reconnect never arms) does nothing', () => {
    expect(shouldAutoSignAfterConnect(inputs({ arm: null }))).toBe('drop');
  });

  test('cached keys / proved signature: no prompt', () => {
    expect(shouldAutoSignAfterConnect(inputs({ keysReady: true }))).toBe('drop');
    expect(shouldAutoSignAfterConnect(inputs({ isInitializing: true }))).toBe('drop');
  });

  test('account-key session and non-EVM chains never sign', () => {
    expect(shouldAutoSignAfterConnect(inputs({ identityMode: 'key' }))).toBe('drop');
    expect(shouldAutoSignAfterConnect(inputs({ nonEvmChain: true }))).toBe('drop');
  });

  test('connection still settling waits; a dropped connection does not prompt', () => {
    expect(shouldAutoSignAfterConnect(inputs({ status: 'reconnecting' }))).toBe('wait');
    expect(shouldAutoSignAfterConnect(inputs({ status: 'connecting', address: undefined }))).toBe('wait');
    expect(shouldAutoSignAfterConnect(inputs({ status: 'disconnected', address: undefined }))).toBe('drop');
  });

  test('a different account than the one approved does not prompt', () => {
    expect(shouldAutoSignAfterConnect(inputs({ address: '0x0000000000000000000000000000000000000002' }))).toBe('drop');
  });

  test('an arm with no known account never signs whatever is connected', () => {
    expect(shouldAutoSignAfterConnect(inputs({ arm: { address: null, armedAt: 1_000 } }))).toBe('drop');
  });

  test('keys still describing the previous wallet: wait, do not drop the new arm', () => {
    const prev = '0x0000000000000000000000000000000000000009';
    expect(shouldAutoSignAfterConnect(inputs({ keysReady: true, keysAddress: prev }))).toBe('wait');
    expect(shouldAutoSignAfterConnect(inputs({ isInitializing: true, keysAddress: prev }))).toBe('wait');
    // Once the provider has reset for the new account, it signs.
    expect(shouldAutoSignAfterConnect(inputs({ keysReady: false, keysAddress: prev }))).toBe('sign');
  });

  test('keys ready for THIS account (any case) drop', () => {
    expect(shouldAutoSignAfterConnect(inputs({ keysReady: true, keysAddress: ADDR.toLowerCase() }))).toBe('drop');
  });

  test('hidden tab (back from the wallet app) waits until visible', () => {
    expect(shouldAutoSignAfterConnect(inputs({ pageVisible: false }))).toBe('wait');
  });

  test('passkey unlock only opens the dialog (WebAuthn needs its own tap)', () => {
    expect(shouldAutoSignAfterConnect(inputs({ passkeyActive: true }))).toBe('open');
  });

  test('identity not wired yet waits', () => {
    expect(shouldAutoSignAfterConnect(inputs({ identityMode: null }))).toBe('wait');
  });

  test('a stale arm is dropped', () => {
    expect(shouldAutoSignAfterConnect(inputs({ now: 1_000 + AUTO_SIGN_ARM_TTL_MS + 1 }))).toBe('drop');
  });
});

describe('arm store', () => {
  beforeEach(() => disarmAutoSignAfterConnect());

  test('one connect yields exactly one take; cancel does not re-prompt', () => {
    armAutoSignAfterConnect(ADDR, 5);
    expect(peekAutoSignArm()).toEqual({ address: ADDR.toLowerCase(), armedAt: 5 });
    expect(takeAutoSignArm()).not.toBeNull();
    // After the (declined) sign request nothing is armed, so no second prompt.
    expect(takeAutoSignArm()).toBeNull();
    expect(shouldAutoSignAfterConnect(inputs({ arm: peekAutoSignArm() }))).toBe('drop');
  });

  test('subscribers hear arm and disarm', () => {
    let calls = 0;
    const off = subscribeAutoSignArm(() => { calls += 1; });
    armAutoSignAfterConnect(null);
    disarmAutoSignAfterConnect();
    disarmAutoSignAfterConnect();
    off();
    armAutoSignAfterConnect(null);
    expect(calls).toBe(2);
  });
});

describe('smart-wallet probe (PR #236 review)', () => {
  test('right after connect, before the getCode probe answers: wait, never sign', () => {
    expect(shouldAutoSignAfterConnect(inputs({ smartWalletProbeSettled: false }))).toBe('wait');
  });

  test('probe says smart wallet but passkey mode has not flipped yet: open, never sign', () => {
    expect(shouldAutoSignAfterConnect(inputs({ isSmartWallet: true, passkeyActive: false }))).toBe('open');
  });

  test('probe settled as an EOA: sign', () => {
    expect(shouldAutoSignAfterConnect(inputs({ smartWalletProbeSettled: true, isSmartWallet: false }))).toBe('sign');
  });
});

describe('Coinbase Wallet after connect (DEV-427)', () => {
  test('waits for local metadata before deciding whether to auto-sign', async () => {
    expect(shouldAutoSignAfterConnect(inputs({ isCoinbaseWallet: null }))).toBe('wait');
    for (const name of ['Coinbase Wallet', 'MetaMask', 'Rabby Wallet', 'Rainbow']) {
      const identity = await resolveWalletIdentity({ id: 'walletConnect', getProvider: async () => ({ session: { peer: { metadata: { name } } } }) });
      expect(shouldAutoSignAfterConnect(inputs({ isCoinbaseWallet: isCoinbaseWalletIdentity(identity) }))).toBe(name === 'Coinbase Wallet' ? 'open' : 'sign');
    }
    const injected = await resolveWalletIdentity({ id: 'injected', getProvider: async () => ({ isCoinbaseWallet: true }) });
    expect(shouldAutoSignAfterConnect(inputs({ isCoinbaseWallet: isCoinbaseWalletIdentity(injected) }))).toBe('open');
  });

  test('opens the dialog instead of firing the signature', () => {
    expect(shouldAutoSignAfterConnect(inputs({ isCoinbaseWallet: true }))).toBe('open');
  });

  test('other wallets keep the DEV-522 auto sign', () => {
    expect(shouldAutoSignAfterConnect(inputs({ isCoinbaseWallet: false }))).toBe('sign');
  });
});
