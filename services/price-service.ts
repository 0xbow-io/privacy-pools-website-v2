import { getConfiguredYieldDeployments } from '@/config/yield';
import { sharePriceKeys, applySharePriceFallback } from '@/services/share-price-rule';
import apiClient from '@/services/api-client';
import { ACTIVE_ENVIRONMENT } from '@/config/environments';

import { getTokenMetadata, getTokenMetadataBySymbol, resolveTokenMetadata } from '@/config/tokens';
import type { TokenPricesResponse } from '@/services/api-types';
import { ALCHEMY_KEY } from '@/config/env';
import { ScopedTtlCache } from '@/services/scoped-ttl-cache';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Raw and mapped consumers share each chain's in-flight request and cached result.
const prices = new ScopedTtlCache<Promise<TokenPricesResponse>>(CACHE_TTL_MS);

export function getTokenPrices(chainId?: string): Promise<TokenPricesResponse> {
  const hit = prices.get(chainId);
  if (hit) return hit;

  const request = apiClient.getTokenPrices(chainId).catch((error) => {
    if (prices.get(chainId) === request) prices.delete(chainId);
    throw error;
  });
  prices.set(chainId, request);
  return request;
}

export async function getPrice(tokenSymbol: string, chainId?: string): Promise<number> {
  const data = await getTokenPrices(chainId);
  const numericChainId = chainId ? Number(chainId) : undefined;
  const tokenBySymbol = getTokenMetadataBySymbol(tokenSymbol, numericChainId);
  const needle = tokenSymbol.toLowerCase();
  const entry = data.prices.find(
    (p) => p.tokenSymbol.toLowerCase() === needle
      || getTokenMetadata(p.tokenSymbol, Number(p.chainId)).symbol.toLowerCase() === needle
      || tokenBySymbol?.address.toLowerCase() === p.tokenSymbol.toLowerCase(),
  );
  const aspPrice = entry ? parseFloat(entry.priceUsd) : 0;
  if (aspPrice > 0) return aspPrice;
  // Testnet: the ASP returns priceUsd "0.00" (and has no SUI row at all), so
  // fill from the Alchemy Prices API for the symbols we fall back on (ETH,
  // USDC, USDT, SUI). Without this, single-asset surfaces like the deposit
  // modal show "$0.00" for a real amount.
  const upper = tokenSymbol.toUpperCase();
  if ((FALLBACK_SYMBOLS as readonly string[]).includes(upper)) {
    const fallback = await fetchAlchemyPrices();
    if (fallback[upper] && fallback[upper] > 0) return fallback[upper];
  }
  return aspPrice;
}

/**
 * Fallback for testnets where the ASP returns priceUsd = "0.00" — we
 * already have an authenticated Alchemy key, so use their Prices API
 * to fill in mainnet-equivalent rates. Cached at the module level for
 * one TTL window. Returns 0 if the key isn't set or the call fails.
 */
const FALLBACK_SYMBOLS = ['ETH', 'USDC', 'USDT', 'SUI'] as const;
const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/** The symbol one chain's native asset trades under, or undefined if unknown. */
function nativeSymbolOfChain(chainId?: string): string | undefined {
  if (!chainId) return undefined;
  const tokens = ACTIVE_ENVIRONMENT.tokensByChain?.[Number(chainId)];
  if (!tokens) return undefined;
  for (const token of Object.values(tokens)) {
    if (token?.address?.toLowerCase() === NATIVE_SENTINEL) return token.symbol;
  }
  return undefined;
}

type FallbackSymbol = (typeof FALLBACK_SYMBOLS)[number];

let alchemyPriceCache: { prices: Record<string, number>; timestamp: number } | null = null;

async function fetchAlchemyPrices(): Promise<Record<string, number>> {
  if (alchemyPriceCache && Date.now() - alchemyPriceCache.timestamp < CACHE_TTL_MS) {
    return alchemyPriceCache.prices;
  }
  if (!ALCHEMY_KEY) return {};
  try {
    const params = FALLBACK_SYMBOLS.map((s) => `symbols=${s}`).join('&');
    const res = await fetch(
      `https://api.g.alchemy.com/prices/v1/${ALCHEMY_KEY}/tokens/by-symbol?${params}`,
    );
    if (!res.ok) return {};
    const json = (await res.json()) as {
      data?: { symbol: string; prices?: { currency: string; value: string }[] }[];
    };
    const prices: Record<string, number> = {};
    for (const entry of json?.data ?? []) {
      const usd = entry.prices?.find((p) => p.currency.toLowerCase() === 'usd');
      if (usd) {
        const value = Number(usd.value);
        if (value > 0) prices[entry.symbol] = value;
      }
    }
    alchemyPriceCache = { prices, timestamp: Date.now() };
    return prices;
  } catch {
    return {};
  }
}

export async function getAllPrices(chainId?: string): Promise<Record<string, number>> {
  const data = await getTokenPrices(chainId);
  const result: Record<string, number> = {};
  const missing = new Set<FallbackSymbol>(FALLBACK_SYMBOLS);
  for (const entry of data.prices) {
    // Some ASP rows can arrive without a tokenSymbol — skip rather than
    // throw on the .toLowerCase() below.
    if (!entry.tokenSymbol) continue;
    const price = parseFloat(entry.priceUsd);
    // /token-prices `tokenSymbol` is a symbol ("USDC"), so resolve to the
    // real metadata and also key the map by the token ADDRESS — callers
    // look prices up by address (priceMap[tokenKey]) and would otherwise
    // miss and fall through to the symbol key only.
    const metadata = resolveTokenMetadata(entry.tokenSymbol, Number(entry.chainId));
    // Three casings of each symbol, because the callers disagree and a symbol
    // that is not all-caps otherwise falls through every one of them. Citrea's
    // native asset is "cBTC": `priceMap[symbol.toUpperCase()]` looks for "CBTC"
    // and the map only had "cBTC" and "cbtc", so a real balance priced at 0
    // (QA, 2026-09-22). Cheap here, versus auditing every lookup.
    result[entry.tokenSymbol] = price;
    result[entry.tokenSymbol.toLowerCase()] = price;
    result[entry.tokenSymbol.toUpperCase()] = price;
    result[metadata.symbol] = price;
    result[metadata.symbol.toUpperCase()] = price;
    if (metadata.address) result[metadata.address.toLowerCase()] = price;
    if (price > 0 && (FALLBACK_SYMBOLS as readonly string[]).includes(metadata.symbol)) {
      missing.delete(metadata.symbol as FallbackSymbol);
    }
  }
  // Sepolia test-mode: ASP returns priceUsd = "0.00" for every token,
  // so Total/Pending Balance reads as $0.00 even when there's a real
  // shielded balance. Fill missing entries from Alchemy's Prices API
  // (we already have the key for RPC).
  if (missing.size > 0) {
    const fallback = await fetchAlchemyPrices();
    for (const symbol of missing) {
      const value = fallback[symbol];
      if (value && value > 0) {
        result[symbol] = value;
        result[symbol.toLowerCase()] = value;
      }
    }
    // Native-asset address key — pools-provider looks up via
    // tokenAddress.toLowerCase() before falling back to the symbol.
    //
    // ONLY for a chain whose native asset really is ether. Every EVM chain in
    // this app shares the one 0xEeee… sentinel, so writing ETH's price here
    // unconditionally priced a Citrea cBTC row and a BSC BNB row in ether —
    // and, worse, CLOBBERED the correct figure the loop above had already
    // written from that chain's own row. Two screens carry a `sameChain` guard
    // apologising for this; the guard belongs here. With no chainId we cannot
    // know whose native it is, so we write nothing.
    if (result.ETH && nativeSymbolOfChain(chainId) === 'ETH') {
      result['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'] = result.ETH;
    }
  }
  // Approximate the share with its underlying only when no feed priced it.
  // Exact portfolio valuation separately uses the vault exchange rate.
  for (const [id, tokens] of Object.entries(ACTIVE_ENVIRONMENT.tokensByChain)) {
    if (chainId && Number(id) !== Number(chainId)) continue;
    applySharePriceFallback(result, sharePriceKeys(Object.values(tokens), getConfiguredYieldDeployments(Number(id))));
  }
  return result;
}
