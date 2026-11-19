import type { SwapPreviewAssetConfig } from './swap-preview-config';

/** Public relayer gas budgets; display estimates only, never transaction inputs. */
const RESHIELD_GAS = 2_020_000n;
const YIELD_INPUT_GAS = 380_000n;
const BRIDGE_GAS_SWAP_GAS = 160_000n;

export function estimateReshieldFee(input: {
  gross: bigint; gasPrice: bigint | null; nativeUsd: number | null; tokenUsd: number | null;
  decimals: number; shareInput: boolean; crossChain: boolean;
  config: SwapPreviewAssetConfig | undefined;
}): bigint | null {
  const { config, gasPrice, nativeUsd, tokenUsd } = input;
  if (!config || gasPrice === null || gasPrice < 0n || !nativeUsd || !tokenUsd
    || !Number.isFinite(nativeUsd) || !Number.isFinite(tokenUsd) || nativeUsd <= 0 || tokenUsd <= 0
    || (config.relayerFlatFee === undefined && config.relayerFeeBps === undefined)) return null;
  // Cross-chain reserves the gas-swap surcharge even when the route may not
  // need it. Review replaces this approximation with a live relayer estimate.
  const gas = RESHIELD_GAS + (input.shareInput ? YIELD_INPUT_GAS : 0n) + (input.crossChain ? BRIDGE_GAS_SWAP_GAS : 0n);
  const scale = 1_000_000_000_000n;
  const ratio = Math.ceil(nativeUsd / tokenUsd * Number(scale));
  if (!Number.isFinite(ratio) || ratio <= 0) return null;
  const numerator = gasPrice * gas * BigInt(ratio) * 10n ** BigInt(input.decimals);
  const denominator = 10n ** 18n * scale;
  const service = config.relayerFeeBps && config.relayerFeeBps > 0n
    ? input.gross * config.relayerFeeBps / 10_000n : config.relayerFlatFee ?? 0n;
  const fee = (numerator + denominator - 1n) / denominator + service;
  if (fee >= input.gross || (config.maxRelayFee > 0n && fee > config.maxRelayFee)) return null;
  return fee;
}

/** Local approximation of the SDK's note sizing from a public route quote. */
export function estimateSwapNote(input: {
  minimumOutput: bigint;
  crossChain: boolean;
  destinationChainId: number;
  config: SwapPreviewAssetConfig | undefined;
  share?: { assetsPerShare: bigint; shareDecimals: number };
}): bigint | null {
  const { config, share } = input;
  if (!config?.enabled || config.vettingFeeBps < 0n || (share && share.assetsPerShare <= 0n)) return null;
  let budget = input.minimumOutput;
  if (input.crossChain && input.destinationChainId === 1) budget = budget * 97n / 100n;
  budget = budget * (input.crossChain ? 98n : 99n) / 100n;
  if (budget <= 0n) return 0n;
  if (!share) return budget * 10_000n / (10_000n + config.vettingFeeBps);
  // SDK yield sizing: rate headroom + zap supply rounding buffer, then
  // inverse ERC-4626 rate and the fee in shares. No amount-specific RPC.
  const headroom = (budget * (input.crossChain ? 500n : 1n) + 999_999n) / 1_000_000n;
  const principal = budget - headroom - 2n;
  if (principal <= 0n) return 0n;
  const capacity = principal * 10n ** BigInt(share.shareDecimals) / share.assetsPerShare;
  return (10_000n * (capacity + 1n) - 1n) / (10_000n + config.vettingFeeBps);
}
