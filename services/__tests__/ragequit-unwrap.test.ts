import { describe, expect, test } from 'bun:test';
import { decodeFunctionData, erc20Abi, encodeEventTopics, encodeAbiParameters } from 'viem';
import { buildRagequitUnwrapCalls, receivedWrappedNative, wrappedNativeWithdrawCall } from '../ragequit-unwrap';
import { supportsAtomicBatch, submitAtomicBatch } from '../wallet-batch';
import { ZAP_UNWRAP_ABI } from '../loose-share-unwrap';
const owner = '0x1111111111111111111111111111111111111111' as const;
const share = '0x2222222222222222222222222222222222222222' as const;
const zap = '0x3333333333333333333333333333333333333333' as const;
const weth = '0x4444444444444444444444444444444444444444' as const;
const d = { ppRouter: zap, ppUSDC: share, zap, ppUSDCDecimals: 18, underlying: weth, underlyingDecimals: 18, underlyingSymbol: 'WETH', nativeMode: true };
const exit = { to: share, data: '0xab' };
describe('ragequit unwrap', () => {
  test('orders exit, exact raw approval, then zap to the owner', () => {
    const amount = 900719925474099312345n;
    const calls = buildRagequitUnwrapCalls(exit, d, amount, owner, 0n);
    expect(calls[0]).toEqual(exit);
    expect(calls.map(c => c.to)).toEqual([share, share, zap]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[1].data as `0x${string}` }).args).toEqual([zap, amount]);
    expect(decodeFunctionData({ abi: ZAP_UNWRAP_ABI, data: calls[2].data as `0x${string}` }).args).toEqual([amount, owner]);
    expect(buildRagequitUnwrapCalls(exit, d, amount, owner, amount)).toHaveLength(2);
    expect(buildRagequitUnwrapCalls(exit, undefined, amount, owner)).toEqual([exit]);
    expect(() => buildRagequitUnwrapCalls(exit, d, 0n, owner)).toThrow();
  });
  test('native conversion uses only actual incoming WETH from the own receipt', () => {
    const log = { address: weth, topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: zap, to: owner } }) as `0x${string}`[], data: encodeAbiParameters([{type:'uint256'}], [987n]) };
    expect(receivedWrappedNative([log, {...log, address: share}], weth, owner)).toBe(987n);
    expect(receivedWrappedNative([log], weth, zap)).toBe(0n);
    expect(wrappedNativeWithdrawCall(weth, 987n).data).toBe('0x2e1a7d4d' + (987n).toString(16).padStart(64,'0'));
    expect(() => wrappedNativeWithdrawCall(weth, 0n)).toThrow();
  });
  test('only current supported or ready atomic capabilities opt into batching', async () => {
    for (const status of ['supported','ready']) expect(supportsAtomicBatch({atomic:{status}})).toBe(true);
    for (const caps of [undefined, {}, {atomic:{status:'unsupported'}}, {atomicBatch:{supported:true}}]) expect(supportsAtomicBatch(caps)).toBe(false);
    let sent = false;
    expect(await submitAtomicBatch({ getCapabilities: async () => ({}), sendCalls: async () => { sent = true; return {id:'x'}; }, getCallsStatus: async () => ({status:'success'}) }, { chainId:1, calls:[exit] })).toBeNull();
    expect(sent).toBe(false);
  });
  test('batch success requires a mined hash, failure never falls back or replays', async () => {
    const deps = { getCapabilities: async () => ({atomic:{status:'ready'}}), sendCalls: async () => ({id:'x'}), getCallsStatus: async () => ({status:'success', receipts:[{ transactionHash:'0xab', status:'success'}]}) };
    expect(await submitAtomicBatch(deps, {chainId:1,calls:[exit]})).toEqual({txHash:'0xab',success:true});
    expect(await submitAtomicBatch({...deps,getCallsStatus: async () => ({status:'failure', receipts:[{transactionHash:'0xab',status:'reverted'}]})}, {chainId:1,calls:[exit]})).toEqual({txHash:'0xab',success:false});
    await expect(submitAtomicBatch({...deps,getCallsStatus: async () => ({status:'success'})}, {chainId:1,calls:[exit]})).rejects.toThrow('unknown');
  });
});
