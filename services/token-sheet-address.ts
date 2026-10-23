/** An address identifies a token only together with the chain it lives on. */
export function isListedTokenAddressOnChain(
  tokens: readonly { address: string; chainId?: number }[],
  address: string,
  chainId: number,
  fallbackChainId: number,
): boolean {
  return tokens.some((token) => (token.chainId ?? fallbackChainId) === chainId
    && token.address.toLowerCase() === address.toLowerCase());
}
