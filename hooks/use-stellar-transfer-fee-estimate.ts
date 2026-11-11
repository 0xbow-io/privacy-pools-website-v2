import { usePublicFeed } from '@/hooks/use-public-feed';
import { FEED_STELLAR_TRANSFER_FEES, readStellarTransferFee, type StellarTransferFees } from '@/services/stellar-transfer-fee-estimate';

/** Selecting inputs reads the shared cache; it cannot trigger any request. */
export function useStellarTransferFeeEstimate(inputs: number): bigint | null {
  return readStellarTransferFee(usePublicFeed<StellarTransferFees>(FEED_STELLAR_TRANSFER_FEES), inputs);
}
