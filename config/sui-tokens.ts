/**
 * Sui token configuration for Privacy Pools.
 *
 * Unlike EVM where tokens are ERC20 contract addresses,
 * Sui uses type parameters (e.g., 0x2::sui::SUI).
 */

export interface SuiTokenInfo {
  symbol: string;
  /** Move type identifier (e.g., "0x2::sui::SUI") */
  typeArg: string;
  decimals: number;
  isNative: boolean;
  /** Icon URL or local asset */
  icon?: string;
}

export const SUI_SUPPORTED_TOKENS: SuiTokenInfo[] = [
  {
    symbol: 'SUI',
    typeArg: '0x2::sui::SUI',
    decimals: 9,
    isNative: true,
  },
  // USDC on Sui (Circle native)
  // {
  //   symbol: 'USDC',
  //   typeArg: '0x...',
  //   decimals: 6,
  //   isNative: false,
  // },
];

export function getSuiTokenBySymbol(symbol: string): SuiTokenInfo | undefined {
  return SUI_SUPPORTED_TOKENS.find(t => t.symbol === symbol.toUpperCase());
}
