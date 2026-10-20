/**
 * Sui witness + proof orchestration hook.
 *
 * Ties together the browser-safe witness construction (services/sui-witness) and
 * in-browser Groth16 proving (useSuiProof) into one call per flow. Each function
 * takes DOMAIN inputs (note fields, roots, Merkle proofs, GVK) and returns the
 * exact param object the corresponding PTB builder hook expects — proofBytes plus
 * the derived on-chain args (commitments, nullifiers, context, GVK ciphertext).
 *
 * This is the piece that closes the gap: useSuiProof takes a pre-built witness;
 * this hook BUILDS that witness (matching the deployed contract + circuits,
 * cross-checked against the protocol SDK) and feeds it through.
 *
 *   const { prepareDepositTx, prepareTransactTx, prepareRagequitTx } = useSuiWitness();
 *   const depositArgs = await prepareDepositTx({ value, tokenId, ... });
 *   await deposit({ ...depositArgs, ... });
 */
import { useCallback } from 'react';
import { useSuiProof } from '@/hooks/use-sui-proof';
import {
  prepareDeposit,
  prepareTransact,
  prepareRagequit,
} from '@/services/sui-witness/flows';
import type {
  DepositWitnessParams,
  TransactWitnessParams,
  RagequitWitnessParams,
} from '@/services/sui-witness/witness';

/** Deposit PTB args (minus the shared packageId/object ids the dispatch hook injects). */
export interface DepositTxArgs {
  amount: bigint;
  proofBytes: Uint8Array;
  outputCommitment: bigint;
  tokenId: bigint;
  noteHint: Uint8Array;
  noteData: Uint8Array;
  /** Derived label (caller may persist for note recovery). */
  label: bigint;
}

/** Transact PTB args (minus shared object ids). */
export interface TransactTxArgs {
  proofBytes: Uint8Array;
  n: number;
  m: number;
  nullifierHashes: bigint[];
  outputCommitments: bigint[];
  stateRoot: bigint;
  keystoreRoot: bigint;
  aspRoot: bigint;
  tokenIdOut: bigint;
  gvkX: bigint;
  gvkY: bigint;
  ciphertext: bigint[];
  processor: string;
  processorData: Uint8Array;
  noteHints: Uint8Array[];
  noteData: Uint8Array[];
  /** Withdrawal amount (0 for a pure transfer). */
  amountOut: bigint;
}

/** Ragequit PTB args (minus shared object ids). */
export interface RagequitTxArgs {
  proofBytes: Uint8Array;
  nullifierHash: bigint;
  commitment: bigint;
  keystoreRoot: bigint;
  ownerAddress: string;
  value: bigint;
  tokenId: bigint;
  label: bigint;
}

export function useSuiWitness() {
  const { generateProof, status, error, reset } = useSuiProof();

  /** Build deposit witness -> proof -> PTB args (native deposit circuit). */
  const prepareDepositTx = useCallback(
    async (params: DepositWitnessParams): Promise<DepositTxArgs> => {
      const prep = await prepareDeposit(params);
      const { proofBytes } = await generateProof('deposit', prep.circuitInputs);
      return {
        amount: params.value,
        proofBytes,
        outputCommitment: prep.outputCommitment,
        tokenId: params.tokenId,
        noteHint: prep.noteHint,
        noteData: prep.noteData,
        label: prep.label,
      };
    },
    [generateProof],
  );

  /**
   * Build transact witness -> SuiTransact wrapper proof -> PTB args.
   * Includes GVK ciphertext + gvkX/gvkY for the deployed transact signature.
   */
  const prepareTransactTx = useCallback(
    async (
      params: TransactWitnessParams,
      opts?: { processor?: string; noteHints?: Uint8Array[]; noteData?: Uint8Array[] },
    ): Promise<TransactTxArgs> => {
      const prep = await prepareTransact(params);
      const { proofBytes } = await generateProof('transact', prep.circuitInputs, prep.nm);
      return {
        proofBytes,
        n: prep.nm.n,
        m: prep.nm.m,
        nullifierHashes: prep.nullifierHashes,
        outputCommitments: prep.outputCommitments,
        stateRoot: params.stateRoot,
        keystoreRoot: params.keystoreRoot,
        aspRoot: params.aspRoot,
        tokenIdOut: params.amountOut === 0n ? 0n : params.tokenIdOut,
        gvkX: prep.gvkX,
        gvkY: prep.gvkY,
        ciphertext: prep.ciphertext,
        // processor @0x0 => any sender may submit (matches contract default).
        processor: opts?.processor ?? '0x0000000000000000000000000000000000000000000000000000000000000000',
        processorData: params.processorData ?? new Uint8Array(0),
        noteHints: opts?.noteHints ?? [],
        noteData: opts?.noteData ?? [],
        amountOut: params.amountOut,
      };
    },
    [generateProof],
  );

  /** Build ragequit witness -> proof -> PTB args (native ragequit circuit). */
  const prepareRagequitTx = useCallback(
    async (
      params: RagequitWitnessParams,
      ownerSuiAddress: string,
    ): Promise<RagequitTxArgs> => {
      const prep = await prepareRagequit(params);
      const { proofBytes } = await generateProof('ragequit', prep.circuitInputs);
      return {
        proofBytes,
        nullifierHash: prep.nullifierHash,
        commitment: prep.commitment,
        keystoreRoot: params.keystoreRoot,
        ownerAddress: ownerSuiAddress,
        value: params.note.value,
        tokenId: params.note.tokenId,
        label: params.note.label,
      };
    },
    [generateProof],
  );

  return {
    prepareDepositTx,
    prepareTransactTx,
    prepareRagequitTx,
    proofStatus: status,
    proofError: error,
    reset,
  };
}
