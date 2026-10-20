import { expect, test } from 'bun:test';
import { encodeFunctionData, encodeFunctionResult, decodeFunctionResult, type Abi } from 'viem';
import { ASPRegistryInteractor, HttpASPDataProvider, ViemRPCInteractor } from '@privacy-pools-v2/sdk';
import type { IHTTPClient, IRPCInteractor } from '@privacy-pools-v2/sdk';
import { ASP_ROOT_ABI, readAssociationSetLeaves, readAssociationSetRoot, validateAssociationSetRegistry } from '../association-set-reader';

const address = '0x1111111111111111111111111111111111111111';
const base = 'https://asp.example/';
const url = `${base.slice(0, -1)}/association-set/leaves?chainId=1&entrypoint=${address}`;
const outcome = async (run: () => Promise<unknown>) => {
  try { return { value: await run() }; }
  catch { return { rejected: true }; }
};

for (const response of [{ leaves: ['1', '0X2', '0xAb', '0'] }, { leaves: [] }, { leaves: ['bad'] }, {}, new Error('offline')]) {
  test(`network leaves match SDK parsing and request options: ${JSON.stringify(response)}`, async () => {
    const calls: unknown[][] = [];
    const http: IHTTPClient = {
      get: async <T>(...args: unknown[]) => { calls.push(args); if (response instanceof Error) throw response; return response as T; },
      post: async () => { throw new Error('Unexpected POST'); },
      getBinary: async () => { throw new Error('Unexpected binary GET'); },
    };
    const sdk = new HttpASPDataProvider({ aspUrl: base, chainId: 1, entrypointAddress: address, httpClient: http });
    const expected = await outcome(() => sdk.getLeaves());
    const actual = await outcome(() => readAssociationSetLeaves(http, url));
    expect(actual).toEqual(expected);
    expect(calls).toEqual([[url, { cache: 'no-store' }], [url, { cache: 'no-store' }]]);
  });
}

for (const result of [0n, 1n, 123456789n, '1', undefined, new Error('RPC unavailable')]) {
  test(`registry result and failures match SDK: ${String(result)}`, async () => {
    const read = async () => { if (result instanceof Error) throw result; return result; };
    // Only readContract is used by this public registry operation.
    const rpc = new ViemRPCInteractor({ publicClient: { readContract: read } as never });
    const sdk = new ASPRegistryInteractor({ rpcInteractor: rpc, contractAddress: address });
    expect(await outcome(() => readAssociationSetRoot(read))).toEqual(await outcome(() => sdk.getLatestASPRoot()));
  });
}

test('narrow registry ABI produces the SDK call and decodes its result', async () => {
  let abi!: Abi;
  const rpc = { readContract: async (request: { abi: Abi }) => { abi = request.abi; return 42n; } } as unknown as IRPCInteractor;
  await new ASPRegistryInteractor({ rpcInteractor: rpc, contractAddress: address }).getLatestASPRoot();
  expect(encodeFunctionData({ abi: ASP_ROOT_ABI, functionName: 'latestASPRoot' }))
    .toBe(encodeFunctionData({ abi, functionName: 'latestASPRoot' }));
  const data = encodeFunctionResult({ abi, functionName: 'latestASPRoot', result: 42n });
  expect(decodeFunctionResult({ abi: ASP_ROOT_ABI, functionName: 'latestASPRoot', data })).toBe(42n);
});

for (const invalid of ['bad', '0x1']) test(`invalid registry address fails before RPC: ${invalid}`, async () => {
  let calls = 0;
  const read = async () => { calls++; return 1n; };
  const rpc = new ViemRPCInteractor({ publicClient: { readContract: read } as never });
  const expected = await outcome(async () => new ASPRegistryInteractor({ rpcInteractor: rpc, contractAddress: invalid as `0x${string}` }).getLatestASPRoot());
  const actual = await outcome(async () => { validateAssociationSetRegistry(invalid); return readAssociationSetRoot(read); });
  expect(actual).toEqual(expected);
  expect(calls).toBe(0);
});
