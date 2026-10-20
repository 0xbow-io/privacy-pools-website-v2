import { useCallback } from 'react';
import { formatUnits } from 'viem';

import { NATIVE_ASSET_ADDRESS } from '@/config/environments';
import { getKnownTokenMetadata } from '@/config/tokens';
import { usePublicFeed } from '@/hooks/use-public-feed';
import { useShareRates } from '@/hooks/use-share-rates';
import { feedPriceMap } from '@/services/public-feeds';
import { underlyingPriceFor } from '@/services/share-rates';
import { isStablecoin } from '@/services/token-format';
import { estimateTransferFee, feedGasPrice, readGasPrice, usdPriceOf } from '@/services/transfer-fee-estimate';

/**
 * The estimated relayer fee for a relayed transfer of one asset on `chainId`,
 * from the gas-price and price feeds (services/transfer-fee-estimate.ts). Reads
 * caches only: nothing here can cause a request.
 */
export function useTransferFeeEstimate(chainId: number): (tokenAddress: string) => bigint | null {
  const gas = usePublicFeed<bigint>(feedGasPrice(chainId));
  const prices = usePublicFeed<Record<string, number>>(feedPriceMap(chainId));
  const { rateFor } = useShareRates();
  return useCallback((tokenAddress: string) => {
    const token = getKnownTokenMetadata(tokenAddress, chainId);
    const native = getKnownTokenMetadata(NATIVE_ASSET_ADDRESS, chainId);
    if (!token || !native) return null;
    const priceMap = prices.status === 'empty' ? undefined : prices.data;
    let usd: number | null;
    if (token.yieldShare) {
      // A share is priced through its underlying, as the relayer's UNDERLYING quoter does.
      const rate = rateFor(chainId, tokenAddress);
      const underlyingUsd = rate ? underlyingPriceFor(rate, priceMap) : 0;
      usd = rate && underlyingUsd > 0 ? underlyingUsd * Number(formatUnits(rate.assetsPerShare, rate.underlyingDecimals)) : null;
    } else {
      usd = usdPriceOf(priceMap, token.address, token.symbol, isStablecoin(token.symbol));
    }
    return estimateTransferFee(
      readGasPrice(gas),
      { decimals: native.decimals, usd: usdPriceOf(priceMap, native.address, native.symbol, false) },
      { decimals: token.decimals, isNative: token.isNative, usd },
    );
  }, [chainId, gas, prices, rateFor]);
}
