import { maxShieldAmountWei } from '@/services/wallet-tx-fees';
import { useCallback } from 'react';
import { usePublicFeed } from '@/hooks/use-public-feed';
import { FEED_STELLAR_DEPOSIT_FEE, readStellarDepositVettingFee, FEED_STELLAR_FEES, readStellarTransferFee, readStellarWithdrawalFee, type StellarFeeEstimates } from '@/services/stellar-fee-estimate';

/** Selecting inputs or entering an amount only reads the shared cache. */
export function useStellarTransferFeeEstimate(inputs: number): bigint | null {
  return readStellarTransferFee(usePublicFeed<StellarFeeEstimates>(FEED_STELLAR_FEES), inputs);
}

/** A cache-only reader for selecting notes across the supported proof shapes. */
export function useStellarFeeFor(withdrawal = false) {
  const state = usePublicFeed<StellarFeeEstimates>(FEED_STELLAR_FEES);
  return useCallback((inputs: number, amount: bigint) => withdrawal
    ? readStellarWithdrawalFee(state, inputs, amount)
    : readStellarTransferFee(state, inputs), [state, withdrawal]);
}

/** The wallet balance already excludes Stellar reserves, liabilities and network headroom. */
export function useStellarDepositMax(spendable: bigint): bigint {
  const vettingFeeBps = readStellarDepositVettingFee(usePublicFeed<number>(FEED_STELLAR_DEPOSIT_FEE));
  return maxShieldAmountWei({ balanceWei: spendable, payIsNative: false, gasPriceWei: null, vettingFeeBps });
}
