/**
 * Sui ragequit hook — emergency withdrawal without ASP approval.
 */
import { useState, useCallback } from 'react';
import { Transaction } from '@mysten/sui/transactions';
import { useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { requireSuiTxSuccess } from '@/services/sui-witness/tx-confirm';
import { friendlyError } from '@/services/sui-witness/abort-codes';

const SUI_CLOCK = '0x6';

export type SuiRagequitStatus = 'idle' | 'submitting' | 'success' | 'error';

export function useSuiRagequit() {
  const [status, setStatus] = useState<SuiRagequitStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const suiClient = useSuiClient();

  const ragequit = useCallback(async (params: {
    packageId: string;
    poolObjectId: string;
    keystoreObjectId: string;
    proofBytes: Uint8Array;
    nullifierHash: bigint;
    commitment: bigint;
    keystoreRoot: bigint;
    ownerAddress: string;
    value: bigint;
    tokenId: bigint;
    label: bigint;
    coinType?: string;
  }) => {
    try {
      setStatus('submitting');
      setError(null);

      const tx = new Transaction();
      tx.moveCall({
        target: `${params.packageId}::pool::ragequit`,
        arguments: [
          tx.object(params.poolObjectId),
          tx.object(params.keystoreObjectId),
          tx.object(SUI_CLOCK),
          tx.pure.vector('u8', Array.from(params.proofBytes)),
          tx.pure.u256(params.nullifierHash),
          tx.pure.u256(params.commitment),
          tx.pure.u256(params.keystoreRoot),
          tx.pure.address(params.ownerAddress),
          tx.pure.u64(params.value),
          tx.pure.u256(params.tokenId),
          tx.pure.u256(params.label),
        ],
        typeArguments: [params.coinType ?? '0x2::sui::SUI'],
      });

      const result = await signAndExecute({ transaction: tx });
      // Digest != success — Move aborts still resolve (codex round 3).
      await requireSuiTxSuccess(suiClient, result.digest, 'Ragequit');
      setStatus('success');
      return result.digest;
    } catch (err) {
      setError(friendlyError(err));
      setStatus('error');
      return null;
    }
  }, [signAndExecute, suiClient]);

  return { status, error, ragequit, reset: useCallback(() => {
    setStatus('idle'); setError(null);
  }, []) };
}
