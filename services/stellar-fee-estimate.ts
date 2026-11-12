import { STELLAR_MAX_RELAY_FEE, STELLAR_RELAYER_FEE_BPS, STELLAR_TESTNET_ID } from '@/config/stellar-deployment';
import type { FeedState } from '@/services/public-feed-scheduler';

export const FEED_STELLAR_FEES = `stellar-fees:${STELLAR_TESTNET_ID}`;
export const STELLAR_FEE_INTERVAL_MS = 60_000;
/** Index n-1 holds the base fee for n inputs, before withdrawal's amount fee. */
export type StellarFeeEstimates = {
  transfer: readonly bigint[];
  withdrawal: readonly bigint[];
};

/**
 * Native-XLM testnet policy: flat 0.02 XLM + 100 stroops inclusion + resource
 * fee with 25% margin, rounded up. The relayer's operator policy can change;
 * these display estimates must follow it, as EVM's gas budget and flat fee do.
 * Affordability reserves and binding signed quotes remain separate.
 */
export function stellarRelayFeeFromResourceFee(resourceFee: bigint): bigint {
  return 200_000n + 100n + (resourceFee * 12_500n + 9_999n) / 10_000n;
}

function readBaseFee(state: FeedState<StellarFeeEstimates>, operation: keyof StellarFeeEstimates, inputs: number, now: number): bigint | null {
  if (state.status !== 'ready' || now - state.at >= 2 * STELLAR_FEE_INTERVAL_MS) return null;
  if (!Number.isInteger(inputs) || inputs < 1 || inputs > 5) return null;
  const fee = state.data[operation][inputs - 1];
  return fee !== undefined && fee >= 0n ? fee : null;
}

/** Cache-only reads. Missing, failed or stale pricing is unknown, as on EVM. */
export function readStellarTransferFee(state: FeedState<StellarFeeEstimates>, inputs: number, now = Date.now()): bigint | null {
  return readBaseFee(state, 'transfer', inputs, now);
}

export function readStellarWithdrawalFee(state: FeedState<StellarFeeEstimates>, inputs: number, amount: bigint, now = Date.now()): bigint | null {
  if (amount <= 0n) return null;
  const base = readBaseFee(state, 'withdrawal', inputs, now);
  if (base === null) return null;
  // The relayer floors the amount fee, then caps the complete fee on-chain.
  const fee = base + amount * STELLAR_RELAYER_FEE_BPS / 10_000n;
  return fee > STELLAR_MAX_RELAY_FEE ? STELLAR_MAX_RELAY_FEE : fee;
}
