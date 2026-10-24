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

function wallet(opts: { chainId: number; code?: string | null; fail?: boolean }) {
  const seen: string[] = [];
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      seen.push(method);
      if (opts.fail) throw new Error('wallet rpc down');
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
  connector?: { id?: string; name?: string } | null;
  ahead?: { key: string; smart: boolean } | null;
  passkey?: boolean;
}) {
  const read = await readWalletCode(
    unlockCodeReaders(input.client, input.walletProvider ?? null, ADDR, 1),
  );
  return decideUnlockWalletKind({
    read,
    passkeyUnlockEnabled: input.passkey ?? true,
    key: KEY,
    ahead: input.ahead ?? null,
    eoaOnlyWallet: isEoaOnlyWallet(input.connector ?? null),
  });
}

const METAMASK = { id: 'io.metamask', name: 'MetaMask' };

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
    expect(await unlockKind({ client: alwaysFails(), walletProvider: w.getProvider, connector: { id: 'walletConnect' } }))
      .toMatchObject({ kind: 'read', smart: true });
  });

  test('an EIP-7702 delegated EOA stays on the signature path', async () => {
    expect(await unlockKind({ client: flakyClient(0, `0xef0100${'11'.repeat(20)}`) })).toMatchObject({ kind: 'read', smart: false });
  });

  test('a wallet on another chain is not asked for this chain\'s code', async () => {
    const w = wallet({ chainId: 10, code: '0x' });
    const kind = await unlockKind({ client: alwaysFails(), walletProvider: w.getProvider, connector: { id: 'walletConnect' } });
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
