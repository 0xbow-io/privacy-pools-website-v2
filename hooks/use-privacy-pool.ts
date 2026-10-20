/**
 * Unified privacy pool hook — routes deposit/transact/ragequit to the
 * correct chain implementation (EVM or Sui) based on the active chain.
 *
 * Usage:
 *   const { deposit, transact, transactWithdraw, ragequit, isSui, isEvm } = usePrivacyPool();
 *
 * Each function accepts chain-agnostic parameters and delegates to the
 * appropriate chain hook (useSuiDeposit or EVM wagmi flow).
 */
import { useCallback, useMemo } from 'react';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useSuiDeposit } from '@/hooks/use-sui-deposit';
import { useSuiTransact } from '@/hooks/use-sui-transact';
import { useSuiRagequit } from '@/hooks/use-sui-ragequit';
import { useSuiRelay } from '@/hooks/use-sui-relay';
import { useSuiProof } from '@/hooks/use-sui-proof';
import { useSuiWitness } from '@/hooks/use-sui-witness';

interface DepositParams {
  amount: bigint;
  proofBytes: Uint8Array;
  outputCommitment: bigint;
  tokenId: bigint;
  noteHint: Uint8Array;
  noteData: Uint8Array;
  /** ASP label registration appended to the deposit PTB (Sui only). */
  registerLabelCiphertext?: number[];
}

interface TransactParams {
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
  /** Move coin type for the withdrawal output (default 0x2::sui::SUI). */
  coinType?: string;
}

interface RagequitParams {
  proofBytes: Uint8Array;
  nullifierHash: bigint;
  commitment: bigint;
  keystoreRoot: bigint;
  ownerAddress: string;
  value: bigint;
  tokenId: bigint;
  label: bigint;
  /** Move coin type for the ragequit withdrawal (default 0x2::sui::SUI). */
  coinType?: string;
}

export function usePrivacyPool() {
  const { activeChain, isSui, isEvm } = useChainRouter();
  const suiDeposit = useSuiDeposit();
  const suiTransact = useSuiTransact();
  const suiRagequit = useSuiRagequit();
  const suiRelay = useSuiRelay();
  const suiProof = useSuiProof();
  const suiWitness = useSuiWitness();

  const suiConfig = useMemo(() => {
    if (!activeChain || activeChain.chainType !== 'sui') return null;
    return activeChain.suiContracts ?? null;
  }, [activeChain]);

  // Global View Key (BabyJubJub pubkey) used to encrypt note ciphertexts on Sui.
  const globalViewKey = useMemo(() => {
    if (!activeChain || activeChain.chainType !== 'sui') return null;
    return activeChain.globalViewKey ?? null;
  }, [activeChain]);

  const deposit = useCallback(async (params: DepositParams) => {
    if (isSui && suiConfig) {
      return suiDeposit.deposit({
        packageId: suiConfig.packageId,
        entrypointObjectId: suiConfig.entrypointObjectId,
        poolObjectId: suiConfig.poolObjectId,
        amount: params.amount,
        proofBytes: params.proofBytes,
        outputCommitment: params.outputCommitment,
        tokenId: params.tokenId,
        noteHint: params.noteHint,
        noteData: params.noteData,
        registerLabel: params.registerLabelCiphertext
          ? {
              aspRegistryObjectId: suiConfig.aspRegistryObjectId,
              ciphertext: params.registerLabelCiphertext,
            }
          : undefined,
      });
    }
    // EVM: delegate to existing wagmi flow
    // TODO: wire to existing EVM deposit hook
    throw new Error('EVM deposit not wired yet');
  }, [isSui, suiConfig, suiDeposit]);

  const transact = useCallback(async (params: TransactParams) => {
    if (isSui && suiConfig) {
      return suiTransact.transact({
        packageId: suiConfig.packageId,
        poolObjectId: suiConfig.poolObjectId,
        keystoreObjectId: suiConfig.keystoreObjectId,
        aspRegistryObjectId: suiConfig.aspRegistryObjectId,
        ...params,
      });
    }
    throw new Error('EVM transact not wired yet');
  }, [isSui, suiConfig, suiTransact]);

  const transactWithdraw = useCallback(async (params: TransactWithdrawParams) => {
    if (isSui && suiConfig) {
      return suiTransact.transactWithdraw({
        packageId: suiConfig.packageId,
        poolObjectId: suiConfig.poolObjectId,
        keystoreObjectId: suiConfig.keystoreObjectId,
        aspRegistryObjectId: suiConfig.aspRegistryObjectId,
        ...params,
      });
    }
    throw new Error('EVM transact withdraw not wired yet');
  }, [isSui, suiConfig, suiTransact]);

  const ragequit = useCallback(async (params: RagequitParams) => {
    if (isSui && suiConfig) {
      return suiRagequit.ragequit({
        packageId: suiConfig.packageId,
        poolObjectId: suiConfig.poolObjectId,
        keystoreObjectId: suiConfig.keystoreObjectId,
        ...params,
      });
    }
    throw new Error('EVM ragequit not wired yet');
  }, [isSui, suiConfig, suiRagequit]);

  // === In-browser proof generation (Sui) ===
  // Generates Groth16 proofs via snarkjs WASM against the statically-hosted
  // circuit artifacts. Returns Arkworks-encoded proofBytes ready for the Move
  // calls above. `generateProof` is the low-level path (caller supplies a
  // pre-built witness); the `prepare*Tx` helpers below build the witness too
  // (commitments, nullifiers, context, GVK ciphertext, Merkle inputs) from
  // domain inputs and return PTB-ready args — pass them straight into
  // deposit/transact/ragequit above.
  const generateProof = suiProof.generateProof;
  const prepareDepositTx = suiWitness.prepareDepositTx;
  const prepareTransactTx = suiWitness.prepareTransactTx;
  const prepareRagequitTx = suiWitness.prepareRagequitTx;

  // === Relay (relayer-mediated withdrawal) ===
  // Safe surface: getValidatedQuote validates the quote (fails closed) before it
  // is bound into a proof; getRelayDetails reads the relayer signer + fee
  // receiver; submitRelay re-checks liveness then POSTs the context-bound relay.
  const getRelayQuote = suiRelay.getValidatedQuote;
  const getRelayDetails = suiRelay.getDetails;
  const submitRelay = suiRelay.submitRelay;

  return {
    deposit,
    transact,
    transactWithdraw,
    ragequit,
    // Proof generation (Sui, in-browser)
    generateProof,
    proofStatus: suiProof.status,
    proofError: suiProof.error,
    // Witness construction + proof orchestration (Sui) — domain inputs -> PTB args
    prepareDepositTx,
    prepareTransactTx,
    prepareRagequitTx,
    // Relay
    getRelayQuote,
    getRelayDetails,
    submitRelay,
    relayQuote: suiRelay.quote,
    relayStatus: suiRelay.status,
    relayError: suiRelay.error,
    relayResult: suiRelay.result,
    // State
    isSui,
    isEvm,
    activeChain,
    suiContracts: suiConfig,
    globalViewKey,
    status: isSui ? suiDeposit.status : 'idle',
    error: isSui ? suiDeposit.error : null,
  };
}
