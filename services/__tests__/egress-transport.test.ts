import { beforeAll, describe, expect, test } from 'bun:test';
import { createPublicClient, createWalletClient, encodeFunctionResult, erc20Abi, multicall3Abi, parseAbiItem } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { FetchHTTPClient } from '@/services/egress-http-client';
import { policedFetch } from '@/services/egress-fetch';
import { policedHttp } from '@/services/egress-transport';
import { EgressRefusedError, setEgressMode } from '@/services/egress-policy';

// The policy SHIPS in report mode; every assertion here is about a request
// being STOPPED, so it pins enforcement instead of inheriting the default.
beforeAll(() => setEgressMode('enforce'));

const ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const HASH = `0x${'1'.repeat(64)}` as const;
const UINT = `0x${'0'.repeat(63)}1` as const;
const RPC = 'https://rpc.example/v2/configured-key';

describe('egress transport boundaries', () => {
  test('SDK get/post/getBinary check headers and origins and never infer intent', async () => {
    let sent = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { sent++; return Response.json({}); }) as typeof fetch;
    try {
      const asp = new FetchHTTPClient('asp', 'https://asp.example');
      for (const run of [
        () => asp.get('https://asp.example/public-key', { headers: { 'X-Labels': HASH } }),
        () => asp.getBinary('https://asp.example/public-key', { headers: { 'X-Labels': HASH } }),
        () => new FetchHTTPClient('relayer', 'https://relayer.example').post('https://relayer.example/v1/quote/evm/1/transfer', {}, { headers: { 'X-Labels': HASH } }),
        () => asp.get(`https://asp.example/labels/${HASH}/status`),
        // The old prefix guard normalized the relative .evil/../ away.
        () => asp.get('https://asp.example.evil/../public-key'),
        () => asp.get('https://asp.example@evil.example/public-key'),
        () => new FetchHTTPClient('asp', 'https://asp.example/api').get('https://asp.example/api-other/../public-key'),
      ]) await expect(run()).rejects.toBeInstanceOf(EgressRefusedError);
      expect(sent).toBe(0);
      await new FetchHTTPClient('asp', 'https://asp.example', 'user-initiated-audit').get(`https://asp.example/labels/${HASH}/status`);
      expect(sent).toBe(1);
    } finally { globalThis.fetch = original; }
  });

  test('ASP and relayer fetches suppress redirects, cookies and page referrers', async () => {
    let actual: RequestInit | undefined;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => { actual = init; return Response.json({}); }) as typeof fetch;
    try {
      await policedFetch('asp', 'https://asp.example', 'https://asp.example/public-key', { redirect: 'follow', credentials: 'include' });
      expect(actual?.redirect).toBe('error');
      expect(actual?.credentials).toBe('omit');
      expect(actual?.referrerPolicy).toBe('no-referrer');
    } finally { globalThis.fetch = original; }
  });

  test('viem refuses before network, including fetchOptions and post-check hook mutations', async () => {
    let sent = 0;
    const fetchFn = (async () => { sent++; return Response.json({ result: '0x1' }); }) as typeof fetch;
    const bad = createPublicClient({ transport: policedHttp(RPC, { fetchFn, retryCount: 0, batch: true }) });
    await expect(bad.request({ method: 'eth_call', params: [{ data: `0x811608fd${'1'.repeat(64)}` }] })).rejects.toBeInstanceOf(EgressRefusedError);
    const header = createPublicClient({ transport: policedHttp(RPC, { fetchFn, retryCount: 0, fetchOptions: { headers: { 'X-Labels': HASH } } }) });
    await expect(header.getChainId()).rejects.toBeInstanceOf(EgressRefusedError);
    const mutate = createPublicClient({ transport: policedHttp(RPC, { fetchFn, retryCount: 0, onFetchRequest: (_req, init) => ({ ...init, body: JSON.stringify({ method: 'eth_call', params: [{ data: `0x811608fd${'1'.repeat(64)}` }] }) }) }) });
    await expect(mutate.getChainId()).rejects.toThrow();
    expect(sent).toBe(0);
  });

  test('real viem read, multicall, logs, receipt and local-wallet send traffic is allowed', async () => {
    const methods: string[] = [];
    const block = { number: '0x1', hash: HASH, parentHash: HASH, transactions: [], timestamp: '0x1', baseFeePerGas: '0x1', gasLimit: '0x1000000', gasUsed: '0x1', difficulty: '0x0', totalDifficulty: '0x0', size: '0x1' };
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      const body = JSON.parse(String(init?.body));
      const response = (call: { id: number; method: string; params?: unknown[] }) => {
        methods.push(call.method);
        let result: unknown = '0x1';
        switch (call.method) {
          case 'eth_fillTransaction': return { jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'unsupported' } };
          case 'eth_chainId': result = '0xaa36a7'; break;
          case 'eth_getBlockByNumber': result = block; break;
          case 'eth_getTransactionByHash': result = { hash: HASH, from: ADDRESS, to: ADDRESS, nonce: '0x0', blockNumber: '0x1', blockHash: HASH, gas: '0x5208', value: '0x0', input: '0x', type: '0x2', transactionIndex: '0x0' }; break;
          case 'eth_getTransactionReceipt': result = { transactionHash: HASH, transactionIndex: '0x0', blockHash: HASH, blockNumber: '0x1', from: ADDRESS, to: ADDRESS, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [], logsBloom: '0x', status: '0x1', type: '0x2', contractAddress: null }; break;
          case 'eth_call': {
            const data = (call.params?.[0] as { data?: string })?.data;
            result = data?.startsWith('0x82ad56cb') ? encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: [{ success: true, returnData: UINT }] }) : UINT;
            break;
          }
          case 'eth_getLogs': result = []; break;
          case 'eth_getCode': result = '0x'; break;
          case 'eth_getTransactionCount': result = '0x0'; break;
          case 'eth_estimateGas': result = '0x5208'; break;
          case 'eth_sendRawTransaction': result = HASH; break;
        }
        return { jsonrpc: '2.0', id: call.id, result };
      };
      return Response.json(Array.isArray(body) ? body.map(response) : response(body));
    }) as typeof fetch;
    const transport = policedHttp(RPC, { fetchFn, retryCount: 0 });
    const client = createPublicClient({ chain: sepolia, transport, pollingInterval: 1, cacheTime: 0 });
    expect(await client.getChainId()).toBe(sepolia.id);
    expect(await client.getBalance({ address: ADDRESS })).toBe(1n);
    expect(await client.readContract({ address: ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESS] })).toBe(1n);
    const contracts = [{ address: ADDRESS, abi: erc20Abi, functionName: 'balanceOf', args: [ADDRESS] }] as const;
    expect((await client.multicall({ contracts }))[0]?.status).toBe('success');
    expect(await client.getLogs({ address: ADDRESS, event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'), fromBlock: 1n })).toEqual([]);
    expect((await client.getBlock({ includeTransactions: true })).number).toBe(1n);
    expect((await client.waitForTransactionReceipt({ hash: HASH, timeout: 1000 })).status).toBe('success');
    // A throwaway test key, with a mocked transport: nothing reaches a chain.
    const wallet = createWalletClient({ chain: sepolia, transport, account: privateKeyToAccount(HASH) });
    expect(await wallet.sendTransaction({ to: ADDRESS, value: 1n })).toBe(HASH);
    for (const method of ['eth_chainId', 'eth_getBalance', 'eth_call', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_fillTransaction', 'eth_getTransactionCount', 'eth_estimateGas', 'eth_sendRawTransaction']) expect(methods).toContain(method);
    expect(methods.includes('eth_subscribe')).toBe(false);
  });
});
