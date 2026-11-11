import { usePublicFeed } from '@/hooks/use-public-feed';
import { FEED_STELLAR_FEES, readStellarTransferFee, readStellarWithdrawalFee, type StellarFeeEstimates } from '@/services/stellar-fee-estimate';

/** Selecting inputs or entering an amount only reads the shared cache. */
export function useStellarTransferFeeEstimate(inputs: number): bigint | null {
  return readStellarTransferFee(usePublicFeed<StellarFeeEstimates>(FEED_STELLAR_FEES), inputs);
}

export function useStellarWithdrawalFeeEstimate(inputs: number, amount: bigint): bigint | null {
  return readStellarWithdrawalFee(usePublicFeed<StellarFeeEstimates>(FEED_STELLAR_FEES), inputs, amount);
}
