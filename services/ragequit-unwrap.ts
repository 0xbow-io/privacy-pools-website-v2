// Pure call construction. No note-dependent reads: the exact share amount is
// already in the note, allowance is held by the wallet's normal balance poll.
import { decodeEventLog, encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import type { YieldDeployment } from '@/services/sdk-types';
import { needsApproval, planUnwrap } from './loose-share-unwrap';
import type { BatchCall } from './wallet-batch';

export function buildRagequitUnwrapCalls(exit: BatchCall, deployment: YieldDeployment | undefined, shares: bigint, owner: Address, allowance = 0n): BatchCall[] {
  if (!deployment) return [exit];
  const plan = planUnwrap(deployment, shares, owner);
  const calls = [exit];
  if (needsApproval(plan, allowance) && plan.spender) calls.push({ to: deployment.ppUSDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [plan.spender, shares] }) });
  calls.push({ to: plan.call.address, data: plan.kind === 'zap' ? encodeFunctionData(plan.call) : encodeFunctionData(plan.call) });
  return calls;
}

// A static EIP-5792 call cannot consume the previous call's return value.
// Never guess the WETH output from an exchange-rate preview. Convert only the
// actual incoming WETH in the wallet's own mined redeem receipt, in a next tx.
export function receivedWrappedNative(logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[], wrapped: Address, owner: Address): bigint {
  let amount = 0n;
  for (const log of logs) {
    if (log.address.toLowerCase() !== wrapped.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: erc20Abi, eventName: 'Transfer', data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (event.args.to.toLowerCase() === owner.toLowerCase()) amount += event.args.value;
    } catch { /* Other token events are irrelevant. */ }
  }
  return amount;
}
export function wrappedNativeWithdrawCall(wrapped: Address, amount: bigint): BatchCall {
  if (amount <= 0n) throw new Error('No WETH received to unwrap.');
  return { to: wrapped, data: encodeFunctionData({ abi: [{ type:'function', name:'withdraw', stateMutability:'nonpayable', inputs:[{name:'amount',type:'uint256'}], outputs:[] }], functionName:'withdraw', args:[amount] }) };
}
