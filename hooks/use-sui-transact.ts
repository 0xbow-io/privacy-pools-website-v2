/**
 * Sui transact hook — handles private transfer/withdrawal via transact.
 *
 * Two modes matching EVM's split:
 * - transact(): Pure transfers (no withdrawal, hides token type)
 * - transact_withdraw<T>(): Withdrawal to recipient (reveals token type)
 *
 * Both include processor_data in context binding for MITM protection.
 */
import { useState, useCallback } from 'react';
import { Transaction } from '@mysten/sui/transactions';
import { useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { requireSuiTxSuccess } from '@/services/sui-witness/tx-confirm';
import { friendlyError } from '@/services/sui-witness/abort-codes';

const SUI_CLOCK = '0x6';

export type SuiTransactStatus = 'idle' | 'submitting' | 'success' | 'error';

interface TransactParams {
  packageId: string;
  poolObjectId: string;
  keystoreObjectId: string;
  aspRegistryObjectId: string;
  proofBytes: Uint8Array;
  n: number;
  m: number;
  nullifierHashes: bigint[];
  outputCommitments: bigint[];
  stateRoot: bigint;
  keystoreRoot: bigint;
  aspRoot: bigint;
  tokenIdOut: bigint;
  /** Global View Key public point (x, y) the outputs were encrypted to. */
  gvkX: bigint;
  gvkY: bigint;
  /** GVK ciphertext blob [ephX, ephY, enc_0..4 per output]; length 2 + 5*m. */
  ciphertext: bigint[];
  processor: string;
  processorData: Uint8Array;
  noteHints: Uint8Array[];
  noteData: Uint8Array[];
}

interface TransactWithdrawParams extends TransactParams {
  amountOut: bigint;
  coinType?: string;
}

export function useSuiTransact() {
  const [status, setStatus] = useState<SuiTransactStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const suiClient = useSuiClient();

  // Pure transfer (no withdrawal, hides token type)
  const transact = useCallback(async (params: TransactParams) => {
    try {
      setStatus('submitting');
      setError(null);

      const tx = new Transaction();
      tx.moveCall({
        target: `${params.packageId}::pool::transact`,
        arguments: [
          tx.object(params.poolObjectId),
          tx.object(params.keystoreObjectId),
          tx.object(params.aspRegistryObjectId),
          tx.object(SUI_CLOCK),
          tx.pure.vector('u8', Array.from(params.proofBytes)),
          tx.pure.u8(params.n),
          tx.pure.u8(params.m),
          tx.pure.vector('u256', params.nullifierHashes),
          tx.pure.vector('u256', params.outputCommitments),
          tx.pure.u256(params.stateRoot),
          tx.pure.u256(params.keystoreRoot),
          tx.pure.u256(params.aspRoot),
          tx.pure.u256(params.tokenIdOut),
          tx.pure.u256(params.gvkX),
          tx.pure.u256(params.gvkY),
          tx.pure.vector('u256', params.ciphertext),
          tx.pure.address(params.processor),
          tx.pure.vector('u8', Array.from(params.processorData)),
          tx.pure.vector('vector<u8>', params.noteHints.map(h => Array.from(h))),
          tx.pure.vector('vector<u8>', params.noteData.map(d => Array.from(d))),
        ],
      });

      const result = await signAndExecute({ transaction: tx });
      // Digest != success — Move aborts still resolve (codex round 3).
      await requireSuiTxSuccess(suiClient, result.digest, 'Transact');
      setStatus('success');
      return result.digest;
    } catch (err) {
      setError(friendlyError(err));
      setStatus('error');
      return null;
    }
  }, [signAndExecute, suiClient]);

  // Withdrawal (reveals token type)
  const transactWithdraw = useCallback(async (params: TransactWithdrawParams) => {
    try {
      setStatus('submitting');
      setError(null);

      const coinType = params.coinType ?? '0x2::sui::SUI';
      const tx = new Transaction();
      tx.moveCall({
        target: `${params.packageId}::pool::transact_withdraw`,
        arguments: [
          tx.object(params.poolObjectId),
          tx.object(params.keystoreObjectId),
          tx.object(params.aspRegistryObjectId),
          tx.object(SUI_CLOCK),
          tx.pure.vector('u8', Array.from(params.proofBytes)),
          tx.pure.u8(params.n),
          tx.pure.u8(params.m),
          tx.pure.vector('u256', params.nullifierHashes),
          tx.pure.vector('u256', params.outputCommitments),
          tx.pure.u256(params.stateRoot),
          tx.pure.u256(params.keystoreRoot),
          tx.pure.u256(params.aspRoot),
          tx.pure.u64(params.amountOut),
          tx.pure.u256(params.tokenIdOut),
          tx.pure.u256(params.gvkX),
          tx.pure.u256(params.gvkY),
          tx.pure.vector('u256', params.ciphertext),
          tx.pure.address(params.processor),
          tx.pure.vector('u8', Array.from(params.processorData)),
          tx.pure.vector('vector<u8>', params.noteHints.map(h => Array.from(h))),
          tx.pure.vector('vector<u8>', params.noteData.map(d => Array.from(d))),
        ],
        typeArguments: [coinType],
      });

      const result = await signAndExecute({ transaction: tx });
      // Digest != success — Move aborts still resolve (codex round 3).
      await requireSuiTxSuccess(suiClient, result.digest, 'Transact');
      setStatus('success');
      return result.digest;
    } catch (err) {
      setError(friendlyError(err));
      setStatus('error');
      return null;
    }
  }, [signAndExecute, suiClient]);

  return { status, error, transact, transactWithdraw, reset: useCallback(() => {
    setStatus('idle'); setError(null);
  }, []) };
}
