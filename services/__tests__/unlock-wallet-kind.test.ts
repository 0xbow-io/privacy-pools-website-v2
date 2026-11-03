// 2026-10-24: a MetaMask user on mainnet could not unlock because one
// eth_getCode read failed and the unlock refused with "Could not verify the
// wallet type". The read is advice; a failure must not end in that refusal for
// an EOA.
import { describe, expect, test } from 'bun:test';

import {
  decideUnlockWalletKind,
  isEoaOnlyWallet,
  readWalletCode,
  unlockCodeReaders,
  walletCodeReaderAllowed,
  walletProviderCodeReader,
  WALLET_TYPE_UNVERIFIED_MESSAGE,
} from '@/services/unlock-wallet-kind';

const ADDR = '0x000000000000000000000000000000000000dEaD';
const KEY = `${ADDR.toLowerCase()}:1`;
const SAFE_CODE = '0x6080604052';

function flakyClient(failures: number, code: string | undefined = undefined) {
  let calls = 0;
  return {
    get calls() { return calls; },
    getCode: async () => {
      calls += 1;
      if (calls <= failures) throw new Error('HTTP request failed.');
      return code;
    },
  };
}

const alwaysFails = () => flakyClient(Number.POSITIVE_INFINITY);

function wallet(opts: { chainId: number; code?: string | null; fail?: boolean; hangOn?: string }) {
  const seen: string[] = [];
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      seen.push(method);
      if (opts.fail) throw new Error('wallet rpc down');
      if (opts.hangOn === method) return new Promise(() => {});
      if (method === 'eth_chainId') return `0x${opts.chainId.toString(16)}`;
      if (method === 'eth_getCode') {
        expect(params).toEqual([ADDR, 'latest']);
        return opts.code ?? '0x';
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { seen, getProvider: async () => provider };
}

async function unlockKind(input: {
  client: ReturnType<typeof flakyClient> | null;
  walletProvider?: (() => Promise<unknown>) | null;
  connector?: { id?: string; name?: string; type?: string } | null;
  ahead?: { key: string; smart: boolean } | null;
  passkey?: boolean;
  tor?: boolean;
  walletTimeoutMs?: number;
}) {
  const getProvider = input.walletProvider;
  const read = await readWalletCode(
    unlockCodeReaders(
      input.client,
      getProvider ? { connector: input.connector ?? null, getProvider } : null,
      ADDR,
      1,
      { torInForce: input.tor ?? false, walletTimeoutMs: input.walletTimeoutMs },
    ),
  );
  return decideUnlockWalletKind({
    read,
    passkeyUnlockEnabled: input.passkey ?? true,
    key: KEY,
    ahead: input.ahead ?? null,
    eoaOnlyWallet: isEoaOnlyWallet(input.connector ?? null),
  });
}

const METAMASK = { id: 'io.metamask', name: 'MetaMask', type: 'injected' };
const RABBY = { id: 'io.rabby', name: 'Rabby Wallet', type: 'injected' };
const WALLETCONNECT = { id: 'walletConnect', name: 'WalletConnect', type: 'walletConnect' };

describe('unlock wallet kind: a failed getCode does not lock an EOA out', () => {
  test('getCode throws once then succeeds: EOA, no refusal', async () => {
    const client = flakyClient(1, undefined);
    const kind = await unlockKind({ client, connector: METAMASK });
    expect(kind).toMatchObject({ kind: 'read', smart: false });
    expect(client.calls).toBe(2);
  });

  test('getCode always throws, MetaMask with its own provider: the wallet answers EOA', async () => {
    const w = wallet({ chainId: 1, code: '0x' });
    const kind = await unlockKind({ client: alwaysFails(), walletProvider: w.getProvider, connector: METAMASK });
    expect(kind).toMatchObject({ kind: 'read', smart: false, read: { source: 'wallet-rpc' } });
    expect(w.seen).toEqual(['eth_chainId', 'eth_getCode']);
  });

  test('getCode always throws and the wallet read fails too, MetaMask: goes on to the signature', async () => {
    const w = wallet({ chainId: 1, fail: true });
    const kind = await unlockKind({ client: alwaysFails(), walletProvider: w.getProvider, connector: METAMASK });
    expect(kind).toEqual({ kind: 'assume-eoa', reason: 'eoa-only-wallet' });
  });

  test('getCode always throws, no public client and no provider, MetaMask: no refusal', async () => {
    const kind = await unlockKind({ client: null, connector: METAMASK });
    expect(kind.kind).toBe('assume-eoa');
  });

  test('getCode always throws, any wallet: the ahead probe verdict for this address:chain is reused', async () => {
    const kind = await unlockKind({ client: alwaysFails(), connector: { id: 'walletConnect' }, ahead: { key: KEY, smart: false } });
    expect(kind).toEqual({ kind: 'ahead', smart: false });
  });

  test('getCode always throws, feature off: signature path as before', async () => {
    const kind = await unlockKind({ client: alwaysFails(), connector: { id: 'walletConnect' }, passkey: false });
    expect(kind).toEqual({ kind: 'assume-eoa', reason: 'feature-off' });
  });
});

describe('unlock wallet kind: smart wallets still reach the passkey', () => {
  test('a contract found by the app RPC is smart', async () => {
    expect(await unlockKind({ client: flakyClient(0, SAFE_CODE), connector: METAMASK })).toMatchObject({ kind: 'read', smart: true });
  });

  test('a contract found by the wallet RPC after the app RPC fails is smart', async () => {
    const w = wallet({ chainId: 1, code: SAFE_CODE });
    expect(await unlockKind({ client: alwaysFails(), walletProvider: w.getProvider, connector: RABBY }))
      .toMatchObject({ kind: 'read', smart: true });
  });

  test('an EIP-7702 delegated EOA stays on the signature path', async () => {
    expect(await unlockKind({ client: flakyClient(0, `0xef0100${'11'.repeat(20)}`) })).toMatchObject({ kind: 'read', smart: false });
  });

  test('a wallet on another chain is not asked for this chain\'s code', async () => {
    const w = wallet({ chainId: 10, code: '0x' });
    const kind = await unlockKind({ client: alwaysFails(), walletProvider: w.getProvider, connector: RABBY });
    expect(w.seen).toEqual(['eth_chainId']);
    expect(kind).toEqual({ kind: 'refuse', message: WALLET_TYPE_UNVERIFIED_MESSAGE });
  });

  test('a stale ahead verdict for another chain is not reused', async () => {
    const kind = await unlockKind({ client: alwaysFails(), connector: { id: 'walletConnect' }, ahead: { key: `${ADDR.toLowerCase()}:10`, smart: false } });
    expect(kind.kind).toBe('refuse');
  });

  test('an unknown wallet with no verdict anywhere asks for a retry', async () => {
    expect((await unlockKind({ client: alwaysFails(), connector: { id: 'io.rabby', name: 'Rabby Wallet' } })).kind).toBe('refuse');
  });
});

describe('unlock wallet kind: the wallet provider is asked only when that names nothing new', () => {
  // A WalletConnect provider answers eth_getCode itself over HTTP to its rpcMap
  // URL, from the user's own IP and outside Tor, naming the address. The ahead
  // probe runs on connect with no click, so that would be an untimed leak.
  test('WalletConnect: the wallet provider is never asked, even with the app RPC down', async () => {
    const w = wallet({ chainId: 1, code: '0x' });
    const kind = await unlockKind({ client: alwaysFails(), walletProvider: w.getProvider, connector: WALLETCONNECT });
    expect(w.seen).toEqual([]);
    expect(kind.kind).toBe('refuse');
  });

  test('under Tor: an injected wallet is never asked either', async () => {
    const w = wallet({ chainId: 1, code: '0x' });
    const kind = await unlockKind({ client: alwaysFails(), walletProvider: w.getProvider, connector: METAMASK, tor: true });
    expect(w.seen).toEqual([]);
    expect(kind).toEqual({ kind: 'assume-eoa', reason: 'eoa-only-wallet' });
  });

  test('under Tor the reader list holds the app RPC only', () => {
    const w = wallet({ chainId: 1 });
    const readers = unlockCodeReaders(flakyClient(0), { connector: METAMASK, getProvider: w.getProvider }, ADDR, 1, { torInForce: true });
    expect(readers.map((r) => r.source)).toEqual(['app-rpc']);
  });

  test('walletCodeReaderAllowed: injected only, never under Tor', () => {
    expect(walletCodeReaderAllowed({ type: 'injected' }, false)).toBe(true);
    expect(walletCodeReaderAllowed({ type: 'injected' }, true)).toBe(false);
    expect(walletCodeReaderAllowed({ type: 'walletConnect' }, false)).toBe(false);
    expect(walletCodeReaderAllowed({ type: 'coinbaseWallet' }, false)).toBe(false);
    expect(walletCodeReaderAllowed({ type: 'metaMask' }, false)).toBe(false);
    expect(walletCodeReaderAllowed({}, false)).toBe(false);
    expect(walletCodeReaderAllowed(null, false)).toBe(false);
  });
});

describe('unlock wallet kind: a wallet that never answers does not hang the unlock', () => {
  test('eth_chainId never answers: times out and falls through to the ahead verdict', async () => {
    const w = wallet({ chainId: 1, hangOn: 'eth_chainId' });
    const kind = await unlockKind({ client: alwaysFails(), walletProvider: w.getProvider, connector: RABBY, ahead: { key: KEY, smart: false }, walletTimeoutMs: 20 });
    expect(w.seen).toEqual(['eth_chainId']);
    expect(kind).toEqual({ kind: 'ahead', smart: false });
  });

  test('eth_getCode never answers, MetaMask: times out and goes on to the signature', async () => {
    const w = wallet({ chainId: 1, hangOn: 'eth_getCode' });
    const kind = await unlockKind({ client: alwaysFails(), walletProvider: w.getProvider, connector: METAMASK, walletTimeoutMs: 20 });
    expect(w.seen).toEqual(['eth_chainId', 'eth_getCode']);
    expect(kind).toEqual({ kind: 'assume-eoa', reason: 'eoa-only-wallet' });
  });

  test('getProvider never resolves: the read throws within the bound', async () => {
    const reader = walletProviderCodeReader(() => new Promise(() => {}), ADDR, 1, 20);
    await expect(reader.read()).rejects.toThrow(/did not answer getProvider/);
  });

  test('the timeout failure is reported like any failed read', async () => {
    const w = wallet({ chainId: 1, hangOn: 'eth_getCode' });
    const failures: string[] = [];
    const read = await readWalletCode(
      unlockCodeReaders(alwaysFails(), { connector: RABBY, getProvider: w.getProvider }, ADDR, 1, { torInForce: false, walletTimeoutMs: 20 }),
      { onFailure: ({ source }) => failures.push(source) },
    );
    expect(read).toBeNull();
    expect(failures).toEqual(['app-rpc', 'app-rpc', 'wallet-rpc']);
  });
});

describe('isEoaOnlyWallet', () => {
  test('MetaMask by id or exact name only', () => {
    expect(isEoaOnlyWallet({ id: 'io.metamask' })).toBe(true);
    expect(isEoaOnlyWallet({ id: 'injected', name: 'MetaMask' })).toBe(true);
    expect(isEoaOnlyWallet({ id: 'injected', name: 'Injected' })).toBe(false);
    expect(isEoaOnlyWallet({ id: 'io.rabby', name: 'Rabby Wallet' })).toBe(false);
    expect(isEoaOnlyWallet(null)).toBe(false);
  });
});

test('the retry copy has no em dash', () => {
  expect(WALLET_TYPE_UNVERIFIED_MESSAGE).not.toContain('—');
});
