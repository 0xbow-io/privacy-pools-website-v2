import { encodeFunctionData, erc20Abi, type Address } from 'viem';
import { submitAtomicBatch, type BatchCall, type WalletBatchDeps } from './wallet-batch';
import type { Hex } from './sdk-types';

/** Exact approvals, including an optional zero reset, in execution order. */
export function buildDepositApprovalCalls(token: Address, spender: Address, values: readonly bigint[]): BatchCall[] {
  return values.map(value => {
    if (value < 0n) throw new Error('Invalid approval amount');
    return { to: token, data: encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[spender,value]}) };
  });
}

/** Only a definitive unsupported answer may enter the existing sequential path. */
export async function submitApprovedDeposit(deps: WalletBatchDeps, args: {
  chainId: number; approvals: BatchCall[]; deposit: BatchCall;
  fallback: () => Promise<Hex>; onBroadcast?: (hash: Hex) => void;
}): Promise<Hex> {
  if (args.approvals.length > 0) {
    const batch = await submitAtomicBatch(deps, { chainId:args.chainId,calls:[...args.approvals,args.deposit],onBroadcast:args.onBroadcast });
    if (batch) {
      if (!batch.success || !batch.txHash) throw new Error('Approve and deposit reverted. Nothing was shielded.');
      return batch.txHash;
    }
  }
  return args.fallback();
}
