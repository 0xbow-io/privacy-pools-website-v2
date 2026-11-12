import { formatUnits } from 'viem';

import { isShareSymbol, plainTokenFigure, tokenAmountLabel } from '@/services/share-display';
import { formatShareAsUnderlying, shareExactAsUnderlyingDecimal, type ShareRate } from '@/services/share-rates';

// The token a claim or payment link names, resolved for DISPLAY (DEV-484).
//
// A 3 USDC request on OP, opened on Prod, read "0.000000000003 0X0B2C":
// getTokenMetadata only knows the active environment's tokens and, for any
// other address, guesses the address prefix as the symbol and 18 decimals.
// On a money screen a wrong amount is worse than none. So a link's token is
// looked up in EVERY environment's registry (the same idea as
// services/receipt-chain.ts for the chain name), and a token none of them
// knows is shown as unknown, with no amount, never with guessed decimals.

type TokenEntry = { symbol: string; decimals: number };
type Registry = Readonly<Record<number, Readonly<Record<string, TokenEntry>>>>;

export type LinkToken =
  | { known: true; symbol: string; decimals: number }
  | { known: false; label: string };

/** "Unknown token 0x0B2C…": the address prefix, said to be an address. */
export function unknownTokenLabel(address: string): string {
  return `Unknown token ${address.slice(0, 6)}…`;
}

/**
 * `registries` in priority order, the active environment first. With no
 * `chainId` (a legacy receipt), every chain of every registry is searched.
 */
export function resolveLinkToken(address: string, chainId: number | undefined, registries: readonly Registry[]): LinkToken {
  const key = address.toLowerCase();
  if (chainId !== undefined) {
    for (const registry of registries) {
      const hit = registry[chainId]?.[key];
      if (hit) return { known: true, symbol: hit.symbol, decimals: hit.decimals };
    }
    return { known: false, label: unknownTokenLabel(address) };
  }
  // No chain: the same address can be different tokens on different chains
  // (the native sentinel is ETH, BNB and cBTC). The first match names it, but
  // only when every match agrees on decimals, since those decide the amount.
  let first: TokenEntry | null = null;
  for (const registry of registries) {
    for (const tokens of Object.values(registry)) {
      const hit = tokens?.[key];
      if (!hit) continue;
      if (!first) first = hit;
      else if (hit.decimals !== first.decimals) return { known: false, label: unknownTokenLabel(address) };
    }
  }
  return first ? { known: true, symbol: first.symbol, decimals: first.decimals } : { known: false, label: unknownTokenLabel(address) };
}

/**
 * The amount line for a link: units and symbol when known, else the unknown label alone.
 * A link's amount is exact SHARES for a yield pool token (the pay page pays that
 * count), so it is shown as the underlying it is worth at `rate`, the page's own
 * feed-grid rate, rounded down (DEV-621). Without a rate it reads as loading
 * ("… USDC", rendered as the shimmer), never as the share count. Display only.
 */
export function linkAmountText(rawAmount: bigint, token: LinkToken, rate?: ShareRate): string {
  if (!token.known) return token.label;
  const shares = formatUnits(rawAmount, token.decimals);
  if (rate && isShareSymbol(token.symbol) && rate.shareDecimals === token.decimals) {
    const underlying = shareExactAsUnderlyingDecimal(shares, rate);
    if (underlying != null) return formatShareAsUnderlying(underlying, rate);
  }
  return tokenAmountLabel(plainTokenFigure(shares, token.symbol), token.symbol);
}
