import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { formatUnits } from 'viem';

import { getChainConfig, supportedEvmChainIds } from '@/config/chains';
import { NATIVE_ASSET_ADDRESS } from '@/config/environments';
import { getKnownTokenMetadata } from '@/config/tokens';
import { useAllChainsPriceMap } from '@/hooks/use-all-chains-price-map';
import { useShareRates } from '@/hooks/use-share-rates';
import { priceFromMap } from '@/services/price-map-merge';
import { publicFeeds, type FeedState } from '@/services/public-feed-scheduler';
import { displayTokenSymbol } from '@/services/share-display';
import { underlyingPriceFor } from '@/services/share-rates';
import { isStablecoin } from '@/services/token-format';
import { feedGasPrice, readGasPrice } from '@/services/transfer-fee-estimate';

export type FeePricing = {
  gasPriceOf: (chainId: number) => bigint | null;
  nativeUsdOf: (chainId: number) => number | null;
  /** USD per whole token; a yield share through its underlying, a stablecoin with no quote at $1. */
  tokenUsdOf: (chainId: number, address: string, symbol?: string) => number | null;
};

type GasStates = readonly FeedState<bigint>[];

/**
 * Gas prices and USD prices for fee figures, read off the public-feed grid.
 * Every supported chain's gas feed is read at once so that which chain a
 * screen prices never changes what is subscribed, and nothing here can cause
 * a request.
 */
export function useFeePricing(activeChainId?: number): FeePricing {
  const priceMap = useAllChainsPriceMap(activeChainId);
  const { rateFor } = useShareRates();

  const keys = useMemo(() => supportedEvmChainIds.map((chainId) => ({ chainId, key: feedGasPrice(chainId) })), []);
  const subscribe = useCallback((onChange: () => void) => {
    const unsubscribes = keys.map(({ key }) => publicFeeds.subscribe(key, onChange));
    return () => { for (const off of unsubscribes) off(); };
  }, [keys]);
  const cache = useRef<GasStates | null>(null);
  const getSnapshot = useCallback((): GasStates => {
    const states = keys.map(({ key }) => publicFeeds.read<bigint>(key));
    const previous = cache.current;
    if (previous && previous.length === states.length && previous.every((state, i) => state === states[i])) return previous;
    cache.current = states;
    return states;
  }, [keys]);
  const gasStates = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_GAS_STATES);

  const gasPriceOf = useCallback((chainId: number) => {
    const i = keys.findIndex((k) => k.chainId === chainId);
    const state = i >= 0 ? gasStates[i] : undefined;
    return state ? readGasPrice(state) : null;
  }, [keys, gasStates]);

  const nativeUsdOf = useCallback((chainId: number) => {
    const symbol = getChainConfig(chainId)?.nativeCurrency.symbol;
    return priceFromMap(priceMap, { chainId, address: NATIVE_ASSET_ADDRESS, symbol }) ?? null;
  }, [priceMap]);

  const tokenUsdOf = useCallback((chainId: number, address: string, symbol?: string) => {
    const meta = getKnownTokenMetadata(address, chainId);
    const sym = symbol ?? meta?.symbol;
    if (meta?.yieldShare) {
      const rate = rateFor(chainId, address);
      if (!rate) return null;
      // The share's own chain first: the bare keys hold whichever chain is active.
      const underlyingUsd = priceFromMap(priceMap, { chainId, address: rate.underlying, symbol: rate.underlyingSymbol })
        ?? priceFromMap(priceMap, { chainId, symbol: displayTokenSymbol(rate.underlyingSymbol) })
        ?? underlyingPriceFor(rate, priceMap);
      return underlyingUsd > 0 ? underlyingUsd * Number(formatUnits(rate.assetsPerShare, rate.underlyingDecimals)) : null;
    }
    const direct = priceFromMap(priceMap, { chainId, address, symbol: sym })
      ?? (sym ? priceFromMap(priceMap, { chainId, symbol: displayTokenSymbol(sym) }) : undefined);
    if (direct !== undefined) return direct;
    return isStablecoin(sym) ? 1 : null;
  }, [priceMap, rateFor]);

  return useMemo(() => ({ gasPriceOf, nativeUsdOf, tokenUsdOf }), [gasPriceOf, nativeUsdOf, tokenUsdOf]);
}

const EMPTY_GAS_STATES: GasStates = Object.freeze([]);
