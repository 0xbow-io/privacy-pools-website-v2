import type { FeedState } from './public-feed-scheduler';

export type SwapPreviewAssetConfig = { enabled: boolean; vettingFeeBps: bigint; maxRelayFee: bigint; relayerFlatFee?: bigint; relayerFeeBps?: bigint };
export type SwapPreviewConfigs = Record<string, SwapPreviewAssetConfig>;
export const feedSwapPreviewConfig = (chainId: number) => `swap-preview-config:${chainId}`;
export const SWAP_PREVIEW_CONFIG_INTERVAL_MS = 5 * 60_000;
export const swapPreviewConfigKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`;

/** A failed refresh never substitutes zero fees or leaves a stale preview. */
export function readSwapPreviewConfigs(state: FeedState<SwapPreviewConfigs>, now = Date.now()): SwapPreviewConfigs | null {
  return state.status === 'ready' && now - state.at < 2 * SWAP_PREVIEW_CONFIG_INTERVAL_MS ? state.data : null;
}
