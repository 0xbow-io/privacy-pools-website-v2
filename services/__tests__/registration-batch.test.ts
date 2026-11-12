import { expect, test } from 'bun:test';
import { createWalletClient, custom, type Hex } from 'viem';
import { bsc } from 'viem/chains';
import { getCapabilities, getCallsStatus, sendCalls } from 'viem/actions';
import type { BatchCall } from '../wallet-batch';
import { hasPendingRegistrationBatch, RegistrationBatchPendingError, submitRegistrationBatch } from '../registration-batch';

const KEYSTORE = '0x6E463391c79b7e1A88eF26E0B023f9A6C9938a71';
const calls = [
  { to: KEYSTORE, data: '0x735aeddc', value: '0' },
  { to: KEYSTORE, data: '0x73897d65', value: '0' },
];
let nextOwner = 0;
const rpcError = (code: number) => Object.assign(new Error(`Wallet refusal ${code}`), { code });

function wallet() {
  const account = `0x${(++nextOwner).toString(16).padStart(40, '0')}` as Hex;
  const sent: any[] = [];
  const checked: string[] = [];
  const state = {
    supported: true,
    sendError: undefined as Error | undefined,
    status: 200,
    loseResponse: false,
    noResponse: false,
    statusError: false,
    onCapabilities: () => {},
  };
  const provider = { request: async ({ method, params }: { method: string; params?: any }) => {
    if (method === 'wallet_getCapabilities') {
      state.onCapabilities();
      return { '0x38': { atomic: { status: state.supported ? 'supported' : 'unsupported' } } };
    }
    if (method === 'wallet_sendCalls') {
      sent.push(params[0]);
      if (state.sendError) throw state.sendError;
      if (state.loseResponse) throw new Error('Connection closed after broadcast');
      if (state.noResponse) return new Promise(() => {});
      return { id: params[0].id };
    }
    if (method === 'wallet_getCallsStatus') {
      checked.push(params[0]);
      if (state.statusError) throw new Error('Wallet disconnected');
      return {
        version: '2.0.0', chainId: '0x38', atomic: true, status: state.status,
        receipts: state.status === 400 ? [] : [{
          transactionHash: `0x${'ab'.repeat(32)}`, status: state.status === 500 ? '0x0' : '0x1',
          blockHash: `0x${'cd'.repeat(32)}`, blockNumber: '0x1', gasUsed: '0x50000', logs: [],
        }],
      };
    }
    throw new Error(`Unexpected wallet request: ${method}`);
  } };
  const client = createWalletClient({ account, chain: bsc, transport: custom(provider, { retryCount: 0 }) });
  const deps = {
    getCapabilities: async () => getCapabilities(client, { account, chainId: 56 }),
    sendCalls: ({ id, calls: batch }: { id?: string; calls: BatchCall[] }) => sendCalls(client, {
      id, forceAtomic: true,
      calls: batch.map(call => ({ to: call.to as Hex, data: call.data as Hex, value: BigInt(call.value ?? 0) })),
    }),
    getCallsStatus: (id: string) => getCallsStatus(client, { id }),
    sleep: async () => {},
  };
  const args = { owner: account, chainId: 56, calls, beforeSend: () => {}, promptTimeoutMs: 20 };
  const run = () => submitRegistrationBatch(deps, args);
  return { state, args, run, sent, checked };
}

test('sends both registration calls atomically through viem, with the bound owner and chain', async () => {
  const w = wallet();
  expect((await w.run())?.success).toBe(true);
  expect(w.sent).toHaveLength(1);
  expect(w.sent[0]).toMatchObject({ from: w.args.owner, chainId: '0x38', atomicRequired: true });
  expect(w.sent[0].calls.map((call: any) => call.data)).toEqual(calls.map(call => call.data));
  expect(w.checked).toEqual([w.sent[0].id]);
});

test('unsupported wallets and a single missing registration call leave submission to the existing path', async () => {
  const w = wallet();
  w.state.supported = false;
  expect(await w.run()).toBeNull();
  w.state.supported = true;
  w.args.calls = [calls[1]];
  expect(await w.run()).toBeNull();
  expect(w.sent).toHaveLength(0);
});

test('cancellation during capability discovery prevents sending and leaves a fresh retry available', async () => {
  const w = wallet();
  let valid = true;
  w.state.onCapabilities = () => { valid = false; };
  w.args.beforeSend = () => { if (!valid) throw new Error('Registration closed'); };
  await expect(w.run()).rejects.toThrow('Registration closed');
  expect(w.sent).toHaveLength(0);
  expect(hasPendingRegistrationBatch(w.args.owner, 56)).toBe(false);
  w.args.beforeSend = () => {};
  expect((await w.run())?.success).toBe(true);
});

test('rejection permits a new attempt, whereas unsupported send permits sequential fallback', async () => {
  for (const code of [4001, 5750, 4200, 5760]) {
    const w = wallet();
    w.state.sendError = rpcError(code);
    if (code === 4200 || code === 5760) expect(await w.run()).toBeNull();
    else await expect(w.run()).rejects.toThrow();
    w.state.sendError = undefined;
    expect((await w.run())?.success).toBe(true);
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1].id).not.toBe(w.sent[0].id);
  }
});

test('a lost send response resumes by the app-provided ID without resending, even if capabilities change', async () => {
  const w = wallet();
  w.state.loseResponse = true;
  await expect(w.run()).rejects.toBeInstanceOf(RegistrationBatchPendingError);
  w.state.supported = false;
  w.args.calls = [calls[1]];
  expect((await w.run())?.success).toBe(true);
  expect(w.sent).toHaveLength(1);
  expect(w.checked).toEqual([w.sent[0].id]);
});

test('a wallet prompt timeout retains the ID and concurrent attempts share the pending submission', async () => {
  const w = wallet();
  w.state.noResponse = true;
  const first = w.run();
  expect(w.run()).toBe(first);
  await expect(first).rejects.toBeInstanceOf(RegistrationBatchPendingError);
  expect((await w.run())?.success).toBe(true);
  expect(w.sent).toHaveLength(1);
});

test('status failures retain the accepted batch until reconnecting can confirm it', async () => {
  const w = wallet();
  w.state.statusError = true;
  await expect(w.run()).rejects.toBeInstanceOf(RegistrationBatchPendingError);
  w.state.statusError = false;
  expect((await w.run())?.success).toBe(true);
  expect(w.sent).toHaveLength(1);
  expect(new Set(w.checked)).toEqual(new Set([w.sent[0].id]));
});

test('a definitive rejection or revert never reports success and permits a later attempt', async () => {
  for (const status of [400, 500]) {
    const w = wallet();
    w.state.status = status;
    if (status === 400) await expect(w.run()).rejects.toThrow('nothing was sent');
    else expect((await w.run())?.success).toBe(false);
    w.state.status = 200;
    expect((await w.run())?.success).toBe(true);
    expect(w.sent).toHaveLength(2);
  }
});

test('a saved batch resumes after a page reload without requiring another submission', async () => {
  const w = wallet();
  const id = `0x${'ef'.repeat(32)}`;
  const key = `pp:registration-batch:56:${w.args.owner.toLowerCase()}`;
  const storage = new Map([[key, id]]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  } });
  try {
    expect(hasPendingRegistrationBatch(w.args.owner, 56)).toBe(true);
    expect(hasPendingRegistrationBatch(w.args.owner, 1)).toBe(false);
    expect((await w.run())?.success).toBe(true);
    expect(w.sent).toHaveLength(0);
    expect(w.checked).toEqual([id]);
    expect(storage.has(key)).toBe(false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});
