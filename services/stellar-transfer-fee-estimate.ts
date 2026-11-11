import type { FeedState } from '@/services/public-feed-scheduler';

export const FEED_STELLAR_TRANSFER_FEES = 'stellar-transfer-fees:202';
export const STELLAR_FEE_INTERVAL_MS = 60_000;
/** Index n-1 holds the fee for n inputs, matching the SDK's quote shape. */
export type StellarTransferFees = readonly bigint[];

/**
 * Native-XLM testnet policy, matching relay-pricing.ts and /v1/details/stellar:
 * flat 0.02 XLM + 100 stroops inclusion + resource fee with 25% margin.
 * Like EVM's gas budget/flat fee, these must follow relayer configuration changes.
 * The deployed policy has no relay-cost floor. This is only a display estimate;
 * the binding quote and the app's independent affordability ceiling still apply.
 */
export function stellarTransferFeeFromResourceFee(resourceFee: bigint): bigint {
  return 200_000n + 100n + (resourceFee * 12_500n + 9_999n) / 10_000n;
}

/** Cache-only read. Missing, failed or stale pricing is unknown, as on EVM. */
export function readStellarTransferFee(state: FeedState<StellarTransferFees>, inputs: number, now = Date.now()): bigint | null {
  if (state.status !== 'ready' || now - state.at >= 2 * STELLAR_FEE_INTERVAL_MS) return null;
  if (!Number.isInteger(inputs) || inputs < 1 || inputs > 5) return null;
  const fee = state.data[inputs - 1];
  return fee !== undefined && fee >= 0n ? fee : null;
}
