import { describe, expect, test } from 'bun:test';
import {
  isWalletReconnectingError,
  signAfterReconnect,
  waitForReconnectSettled,
  WALLET_RECONNECTING_MESSAGE,
  WalletReconnectingError,
  walletErrorLine,
  type ReconnectStore,
  type WagmiStatus,
} from '../wallet-reconnect';
import { SignatureTimeoutError, withSignatureTimeout } from '../wallet-signature-timeout';

// The exact shape @wagmi/core 3.4.8 throws (errors/config.js), Mike's DEV-576 report.
class ConnectorUnavailableReconnectingError extends Error {
  shortMessage = 'Connector "MetaMask" unavailable while reconnecting.';
  constructor() {
    super([
      'Connector "MetaMask" unavailable while reconnecting.',
      '',
      'Details: During the reconnection step, the only connector methods guaranteed to be available are: `id`, `name`, `type`, `uid`.',
      'Version: @wagmi/core@3.4.8',
    ].join('\n'));
    this.name = 'ConnectorUnavailableReconnectingError';
  }
}

function fakeStore(initial: WagmiStatus) {
  let status = initial;
  const listeners = new Set<(s: WagmiStatus) => void>();
  const store: ReconnectStore = {
    getStatus: () => status,
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
  };
  return {
    store,
    listeners,
    set(next: WagmiStatus) { status = next; for (const l of [...listeners]) l(next); },
  };
}

describe('isWalletReconnectingError', () => {
  test('matches wagmi error by name, message, and as a cause', () => {
    expect(isWalletReconnectingError(new ConnectorUnavailableReconnectingError())).toBe(true);
    expect(isWalletReconnectingError(new Error('Connector "X" unavailable while reconnecting.'))).toBe(true);
    expect(isWalletReconnectingError(Object.assign(new Error('wrapped'), { cause: new ConnectorUnavailableReconnectingError() }))).toBe(true);
    expect(isWalletReconnectingError(new WalletReconnectingError())).toBe(true);
  });
  test('does not match unrelated errors', () => {
    expect(isWalletReconnectingError(new Error('User rejected the request.'))).toBe(false);
    expect(isWalletReconnectingError(null)).toBe(false);
  });
});

describe('waitForReconnectSettled', () => {
  test('resolves at once when connected', async () => {
    expect(await waitForReconnectSettled(fakeStore('connected').store, 10)).toBe('settled');
  });
  test('waits for reconnecting to become connected and unsubscribes', async () => {
    const s = fakeStore('reconnecting');
    const p = waitForReconnectSettled(s.store, 5_000);
    expect(s.listeners.size).toBe(1);
    s.set('connected');
    expect(await p).toBe('settled');
    expect(s.listeners.size).toBe(0);
  });
  test('times out without rejecting', async () => {
    const s = fakeStore('reconnecting');
    expect(await waitForReconnectSettled(s.store, 5)).toBe('timeout');
    expect(s.listeners.size).toBe(0);
  });
});

describe('signAfterReconnect', () => {
  test('does not ask for the signature until the reconnect settles', async () => {
    const s = fakeStore('reconnecting');
    const events: string[] = [];
    const p = signAfterReconnect(async () => { events.push(`sign:${s.store.getStatus()}`); return '0xsig'; }, s.store, {
      timeoutMs: 5_000, onWait: (phase) => events.push(`wait:${phase}`),
    });
    await Promise.resolve();
    expect(events).toEqual(['wait:before']);
    s.set('connected');
    expect(await p).toBe('0xsig');
    expect(events).toEqual(['wait:before', 'sign:connected']);
  });

  test('retries exactly once after a reconnecting error', async () => {
    const s = fakeStore('connected');
    let calls = 0;
    const retries: unknown[] = [];
    const sig = await signAfterReconnect(async () => {
      calls++;
      if (calls === 1) { s.set('reconnecting'); setTimeout(() => s.set('connected'), 1); throw new ConnectorUnavailableReconnectingError(); }
      return '0xsig';
    }, s.store, { timeoutMs: 5_000, onRetry: (e) => retries.push(e) });
    expect(sig).toBe('0xsig');
    expect(calls).toBe(2);
    expect(retries.length).toBe(1);
  });

  test('a second reconnecting error becomes one plain line with the original as cause', async () => {
    const s = fakeStore('connected');
    let calls = 0;
    const err = await signAfterReconnect(async () => { calls++; throw new ConnectorUnavailableReconnectingError(); }, s.store, { timeoutMs: 5 })
      .catch((e) => e);
    expect(calls).toBe(2);
    expect(err).toBeInstanceOf(WalletReconnectingError);
    expect(err.message).toBe(WALLET_RECONNECTING_MESSAGE);
    expect(err.cause).toBeInstanceOf(ConnectorUnavailableReconnectingError);
  });

  test('a user rejection is not retried', async () => {
    const s = fakeStore('connected');
    let calls = 0;
    await expect(signAfterReconnect(async () => { calls++; throw new Error('User rejected'); }, s.store)).rejects.toThrow('User rejected');
    expect(calls).toBe(1);
  });
});

describe('signAfterReconnect and the Coinbase 45s bound', () => {
  test('a SignatureTimeoutError is not retried and passes through unchanged', async () => {
    const s = fakeStore('connected');
    let calls = 0;
    const err = await signAfterReconnect(() => {
      calls++;
      return withSignatureTimeout(new Promise<string>(() => {}), { stage: 'initial', walletName: 'Coinbase Wallet', timeoutMs: 5 });
    }, s.store).catch((e) => e);
    expect(calls).toBe(1);
    expect(err).toBeInstanceOf(SignatureTimeoutError);
    expect(isWalletReconnectingError(err)).toBe(false);
  });

  test('the wait runs before the bound starts, so reconnecting time does not count against it', async () => {
    const s = fakeStore('reconnecting');
    let started = 0;
    const p = signAfterReconnect(() => {
      started = Date.now();
      return withSignatureTimeout(Promise.resolve('0xsig'), { stage: 'initial', timeoutMs: 5 });
    }, s.store, { timeoutMs: 5_000 });
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toBe(0);
    s.set('connected');
    expect(await p).toBe('0xsig');
    expect(started).toBeGreaterThan(0);
  });
});

describe('walletErrorLine', () => {
  test('reconnecting error is the plain line, no wagmi dump', () => {
    const line = walletErrorLine(new ConnectorUnavailableReconnectingError());
    expect(line).toBe('Your wallet is still reconnecting. Try again in a moment.');
    expect(line).not.toContain('@wagmi');
  });
  test('a wagmi/viem dump is cut to its short message', () => {
    const e = Object.assign(new Error('Something broke.\n\nDetails: x\nVersion: viem@2.0.0'), { shortMessage: 'Something broke.' });
    expect(walletErrorLine(e)).toBe('Something broke.');
  });
  test('plain app messages pass through', () => {
    expect(walletErrorLine(new Error('Signature cancelled.'))).toBe('Signature cancelled.');
  });
  test('the copy has no em dash', () => {
    expect(WALLET_RECONNECTING_MESSAGE).not.toContain('—');
  });
});
