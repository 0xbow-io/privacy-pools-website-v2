/**
 * Sui deposit hook — handles the full deposit flow for Sui chain.
 *
 * Deposits go through the Entrypoint module (not pool::deposit directly).
 * The Entrypoint validates asset config, charges vetting fees, then
 * delegates to pool::deposit via its stored DepositorCap.
 *
 * Steps:
 * 1. Generate deposit proof via snarkjs (browser WASM)
 * 2. Encode proof + VK to Arkworks BN254 format
 * 3. Build PTB with entrypoint::deposit Move call
 * 4. Sign and execute via Sui wallet
 * 5. Track transaction result
 */
import { useState, useCallback } from 'react';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { friendlyError } from '@/services/sui-witness/abort-codes';
import { appendRegisterLabelCall } from '@/services/sui-witness/asp-registration';

const SUI_CLOCK = '0x6';

export type SuiDepositStatus = 'idle' | 'generating_proof' | 'submitting' | 'success' | 'error';

interface SuiDepositResult {
  txDigest: string;
  commitment: string;
}

interface UseSuiDepositReturn {
  status: SuiDepositStatus;
  error: string | null;
  result: SuiDepositResult | null;
  deposit: (params: {
    packageId: string;
    entrypointObjectId: string;
    poolObjectId: string;
    amount: bigint;
    proofBytes: Uint8Array;
    outputCommitment: bigint;
    tokenId: bigint;
    noteHint: Uint8Array;
    noteData: Uint8Array;
    coinType?: string;
    /** When set, register_label joins the deposit PTB (atomic, one signature). */
    registerLabel?: { aspRegistryObjectId: string; ciphertext: number[] };
  }) => Promise<SuiDepositResult | null>;
  reset: () => void;
}

export function useSuiDeposit(): UseSuiDepositReturn {
  const [status, setStatus] = useState<SuiDepositStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SuiDepositResult | null>(null);
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const client = useSuiClient();

  const deposit = useCallback(async (params: {
    packageId: string;
    entrypointObjectId: string;
    poolObjectId: string;
    amount: bigint;
    proofBytes: Uint8Array;
    outputCommitment: bigint;
    tokenId: bigint;
    noteHint: Uint8Array;
    noteData: Uint8Array;
    coinType?: string;
    registerLabel?: { aspRegistryObjectId: string; ciphertext: number[] };
  }) => {
    try {
      setStatus('submitting');
      setError(null);

      const coinType = params.coinType ?? '0x2::sui::SUI';
      const tx = new Transaction();

      // Source the deposit amount from a coin the user actually owns.
      // `coinWithBalance` auto-selects (and merges, if needed) the user's coins
      // of `coinType`, splitting off exactly `amount`. For native SUI it draws
      // from the gas coin while reserving gas headroom (so an exact / "deposit
      // max" amount no longer double-counts gas); for other tokens it selects
      // owned `Coin<T>` objects rather than `tx.gas`.
      const depositCoin = tx.add(
        coinWithBalance({ type: coinType, balance: params.amount }),
      );

      // Call entrypoint::deposit (routes through to pool::deposit via DepositorCap)
      tx.moveCall({
        target: `${params.packageId}::entrypoint::deposit`,
        arguments: [
          tx.object(params.entrypointObjectId),
          tx.object(params.poolObjectId),
          tx.object(SUI_CLOCK),
          depositCoin,
          tx.pure.vector('u8', Array.from(params.proofBytes)),
          tx.pure.u256(params.outputCommitment),
          tx.pure.u256(params.tokenId),
          tx.pure.vector('u8', Array.from(params.noteHint)),
          tx.pure.vector('u8', Array.from(params.noteData)),
        ],
        typeArguments: [coinType],
      });

      // Register the deposit's label with the ASP in the same transaction —
      // without it the ASP never reviews the deposit and it stays pending.
      if (params.registerLabel) {
        appendRegisterLabelCall(tx, {
          packageId: params.packageId,
          aspRegistryObjectId: params.registerLabel.aspRegistryObjectId,
          ciphertext: params.registerLabel.ciphertext,
        });
      }

      const txResult = await signAndExecute({
        transaction: tx,
      });
      // A digest is NOT success — Move aborts still resolve with one (codex
      // round 3: this fabricated phantom deposit notes on aborted deposits).
      const { requireSuiTxSuccess } = await import('@/services/sui-witness/tx-confirm');
      await requireSuiTxSuccess(client, txResult.digest, 'Deposit');

      const depositResult: SuiDepositResult = {
        txDigest: txResult.digest,
        commitment: params.outputCommitment.toString(),
      };

      setResult(depositResult);
      setStatus('success');
      return depositResult;
    } catch (err) {
      const message = friendlyError(err);
      setError(message);
      setStatus('error');
      return null;
    }
  }, [signAndExecute, client]);

  const reset = useCallback(() => {
    setStatus('idle');
    setError(null);
    setResult(null);
  }, []);

  return { status, error, result, deposit, reset };
}
