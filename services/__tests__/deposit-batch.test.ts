import { expect, test } from 'bun:test';
import { decodeFunctionData, erc20Abi } from 'viem';
import { buildDepositApprovalCalls, submitApprovedDeposit } from '../deposit-batch';
const token = '0x1111111111111111111111111111111111111111' as const;
const spender = '0x2222222222222222222222222222222222222222' as const;
const deposit = {to:spender,data:'0xab',value:'0x1'};
test('deposit approval preserves zero-reset order and exact amount before deposit', () => {
  const calls = buildDepositApprovalCalls(token, spender, [0n,123n]);
  expect(calls.map(c => decodeFunctionData({abi:erc20Abi,data:c.data as `0x${string}`}).args)).toEqual([[spender,0n],[spender,123n]]);
  expect(() => buildDepositApprovalCalls(token,spender,[-1n])).toThrow();
});
test('deposit batch and unsupported fallback each submit only once', async () => {
  let fallback = 0;
  let sent: unknown;
  const deps = { getCapabilities: async () => ({atomic:{status:'supported'}}), sendCalls: async (args: unknown) => {sent=args;return {id:'x'};},getCallsStatus:async()=>({status:'success',receipts:[{transactionHash:'0xabc',status:'success'}]}) };
  const args = {chainId:1,approvals:buildDepositApprovalCalls(token,spender,[123n]),deposit,fallback:async()=>{fallback++;return '0xdef' as const;}};
  expect(await submitApprovedDeposit(deps,args)).toBe('0xabc');
  expect(sent).toEqual({chainId:1,calls:[...args.approvals,deposit]});
  expect(fallback).toBe(0);
  expect(await submitApprovedDeposit({...deps,getCapabilities:async()=>({})},args)).toBe('0xdef');
  expect(fallback).toBe(1);
  await expect(submitApprovedDeposit({...deps,getCallsStatus:async()=>({status:'failure',receipts:[{transactionHash:'0xabc',status:'reverted'}]})},args)).rejects.toThrow('reverted');
  expect(fallback).toBe(1);
  await expect(submitApprovedDeposit({...deps,sendCalls:async()=>{throw new Error('timeout');}},args)).rejects.toThrow('timeout');
  expect(fallback).toBe(1);
});
