import { displayTokenSymbol } from '@/services/share-display';

/** Entrypoint deposit-for has no router funding route in this flow. */
export function requestWalletRefusal(token: { symbol: string; isNative: boolean; yieldShare?: unknown; withdrawOnly?: boolean }, nativeRouteConfigured: boolean): string | null {
  const symbol = displayTokenSymbol(token.symbol);
  if (token.isNative && nativeRouteConfigured) {
    return `${symbol} deposits on this network go through the yield vault, so this request cannot be paid from a wallet. Pay it from a shielded ${symbol} balance, or ask for a new request.`;
  }
  if (token.yieldShare) {
    return `Wallet payment is not available for this yield pool yet. Pay this request from a shielded ${symbol} balance.`;
  }
  if (token.withdrawOnly) {
    return `${symbol} deposits are closed on this network. Pay this request from a shielded ${symbol} balance, or ask for a new request.`;
  }
  return null;
}
