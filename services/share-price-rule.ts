// Pure registry-driven approximation used only when no feed prices the share.
type PriceToken = { symbol: string; address: string; isNative: boolean; yieldShare?: unknown };
type PriceDeployment = { ppUSDC: string; underlyingSymbol: string; nativeMode?: boolean };
export function sharePriceKeys(tokens: readonly PriceToken[], deployments: readonly PriceDeployment[]) {
  return tokens.flatMap((token) => {
    if (!token.yieldShare) return [];
    const deployment = deployments.find((d) => d.ppUSDC.toLowerCase() === token.address.toLowerCase());
    if (!deployment) return [];
    const underlying = deployment.nativeMode
      ? tokens.find((t) => t.isNative)?.symbol
      : deployment.underlyingSymbol;
    return underlying ? [{ symbol: token.symbol, address: token.address.toLowerCase(), underlying }] : [];
  });
}

export function applySharePriceFallback(prices: Record<string, number>, shares: ReturnType<typeof sharePriceKeys>): void {
  for (const share of shares) {
    const keys = [share.address, share.symbol, share.symbol.toLowerCase()];
    const positive = (n: number | undefined): n is number => n != null && Number.isFinite(n) && n > 0;
    // A share-specific feed quote wins, including address-only quotes.
    const quote = keys.map((key) => prices[key]).find(positive);
    const underlyingPrice = prices[share.underlying] ?? prices[share.underlying.toLowerCase()];
    const price = quote ?? underlyingPrice;
    if (!positive(price)) continue;
    for (const key of keys) prices[key] = price;
  }
}
