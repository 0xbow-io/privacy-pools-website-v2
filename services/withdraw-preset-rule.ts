import { displayTokenSymbol } from '@/services/share-display';
export function usesNativeWithdrawPresets(symbol: string): boolean {
  return ['ETH', 'SUI', 'CBTC', 'BTC'].includes(displayTokenSymbol(symbol).toUpperCase());
}
