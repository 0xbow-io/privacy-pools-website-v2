import { sameSymbol } from '@/services/symbol-match';

/**
 * Which pool token the hub must push into the open inline Withdraw flow, or
 * null when nothing should move (DEV-531, the Withdraw half of DEV-469).
 *
 * The hub opens the inline flow once, under whatever its card token is at that
 * moment. On a chain whose holdings are still loading that is the native asset
 * (BNB), and the flow pins it. When holdings land the card moves to the held
 * asset (USDT), but nothing told the flow, so the card read "16.23 USDT" while
 * the flow checked the BNB balance ("exceeds your shielded balance (0.0000
 * BNB)"), routed "BNB → ETH" and quoted 16 BNB.
 *
 * Only on the form step: past it the amount and asset are bound into a quote.
 * The symbol must exist in the chain's registry, and the registry spelling is
 * returned (the flow's comparisons are case-sensitive: ppUSDT, not PPUSDT).
 */
export function inlineWithdrawTokenToPush(params: {
  focused: boolean;
  action: string;
  inline: boolean;
  step: string;
  isSui: boolean;
  hubSymbol: string;
  flowSymbol: string;
  chainTokens: readonly { symbol: string }[];
}): string | null {
  const { focused, action, inline, step, isSui, hubSymbol, flowSymbol, chainTokens } = params;
  if (!focused || action !== 'withdraw' || !inline || step !== 'withdraw' || isSui) return null;
  const meta = chainTokens.find((t) => sameSymbol(t.symbol, hubSymbol));
  if (!meta || meta.symbol === flowSymbol) return null;
  return meta.symbol;
}
