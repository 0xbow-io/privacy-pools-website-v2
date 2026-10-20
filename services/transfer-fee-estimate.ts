import type { FeedState } from '@/services/public-feed-scheduler';

/**
 * The relayer's shielded-transfer fee, reproduced from public inputs so that
 * pricing one never needs a request of its own.
 *
 * The relayer prices a transfer as (v2-monorepo, packages/relayer/relayer/src/
 * quote/evm/evm.quote.service.ts, `quoteTransfer`):
 *
 *     fee = convert(eth_gasPrice × RELAY_GAS_BUDGET.shieldedTransfer) + flat_fee_amount
 *
 * capped at the asset's on-chain maxRelayFee. The gas budget is a fixed
 * relayer constant, the gas price is the chain's own `eth_gasPrice` (read here
 * by the gas-price feed), and the conversion into a non-native asset is a
 * market rate, approximated here by the ASP price feed. The cap only ever
 * lowers the fee, so leaving it out keeps this estimate on the high side.
 *
 * This is an estimate for the UI: every relayed spend still takes a binding
 * quote before it is submitted.
 */

/**
 * `RELAY_GAS_BUDGET.shieldedTransfer` in the relayer's relay_gas_budget.ts
 * (calibrated 2026-09-25, the p90 of 185 relays). The relayer recalibrates it
 * after contract or circuit changes; this copy has to follow.
 */
export const SHIELDED_TRANSFER_GAS = 850_000n;

/**
 * The relayer's `flat_fee_amount` default, published per chain as
 * `fixedFeeAmount` on /v1/details. It is added in the asset's smallest unit,
 * after the gas cost has been converted.
 */
export const RELAYER_FLAT_FEE = 21_000n;

/** Gas moves per block; the fee gate only needs its order of magnitude. */
export const GAS_PRICE_INTERVAL_MS = 60_000;
export const feedGasPrice = (chainId: number) => `gas-price:${chainId}`;

/** A failed or stale reading is unknown, never a reused old price. */
export function readGasPrice(state: FeedState<bigint>, now = Date.now()): bigint | null {
  if (state.status !== 'ready' || now - state.at >= 2 * GAS_PRICE_INTERVAL_MS) return null;
  return state.data >= 0n ? state.data : null;
}

export type FeeAsset = {
  decimals: number;
  isNative: boolean;
  /** USD per whole token; unused for the native asset. */
  usd: number | null;
};

const RATE_SCALE = 10n ** 12n;

const priced = (usd: number | null): usd is number => usd !== null && Number.isFinite(usd) && usd > 0;

/** The estimated relayer fee in the asset's smallest unit, or null when it cannot be priced. */
export function estimateTransferFee(
  gasPriceWei: bigint | null,
  native: { decimals: number; usd: number | null },
  asset: FeeAsset,
): bigint | null {
  if (gasPriceWei === null || gasPriceWei < 0n) return null;
  const gasCostWei = gasPriceWei * SHIELDED_TRANSFER_GAS;
  if (asset.isNative) return gasCostWei + RELAYER_FLAT_FEE;
  if (!priced(native.usd) || !priced(asset.usd)) return null;
  // Asset units per native unit, rounded up so the estimate never understates.
  const scaledRate = Math.ceil((native.usd / asset.usd) * Number(RATE_SCALE));
  if (!Number.isFinite(scaledRate) || scaledRate <= 0) return null;
  const rate = BigInt(scaledRate);
  const numerator = gasCostWei * rate * 10n ** BigInt(asset.decimals);
  const denominator = 10n ** BigInt(native.decimals) * RATE_SCALE;
  return (numerator + denominator - 1n) / denominator + RELAYER_FLAT_FEE;
}

/** USD per whole token from a price map keyed by address, then symbol; stablecoins default to $1. */
export function usdPriceOf(
  priceMap: Record<string, number> | undefined,
  address: string,
  symbol: string,
  isStable: boolean,
): number | null {
  for (const key of [address.toLowerCase(), symbol, symbol.toUpperCase(), symbol.toLowerCase()]) {
    const price = priceMap?.[key];
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) return price;
  }
  return isStable ? 1 : null;
}
