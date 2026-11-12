import { isShareSymbol } from '@/services/share-display';
import type { ShareRate } from '@/services/share-rates';
import { sideFigure, shareUnitsRate } from '@/services/sdk-error-amounts';
import { formatSwapExitEstimate } from '@/services/swap-exit-estimate';
import { isStablecoin, LOADING_FIGURE } from '@/services/token-format';

/**
 * The Swap form's headline once a Review press was refused below the pool
 * minimum: the net deposit that refusal was computed on, in the OUTPUT asset's
 * base units. For a share output that is a share count, so it is converted to
 * the underlying it is worth at the scheduled rate before it is printed, the
 * same conversion and rounding the refusal sentence uses
 * (services/sdk-error-amounts.ts), so the headline and the error name one
 * number. 9.639123 shares at 1.05 is "~10.12 USDT", not "~9.63 USDT" (review on
 * #26).
 *
 * No rate yet: `loading`. The caller shows the shimmer. A share count under the
 * coin's name would be a wrong number (DEV-621).
 */
export type QuotedNetFigure = { status: 'loading' } | { status: 'ready'; text: string };

export function quotedNetFigure(
  netWei: bigint,
  token: { symbol: string; decimals: number },
  rate: ShareRate | undefined,
): QuotedNetFigure {
  if (isShareSymbol(token.symbol)) {
    const figure = sideFigure(netWei, { decimals: token.decimals, symbol: token.symbol, rate: shareUnitsRate(token.symbol, rate) });
    return figure === LOADING_FIGURE ? { status: 'loading' } : { status: 'ready', text: `~${figure}` };
  }
  return {
    status: 'ready',
    text: `~${isStablecoin(token.symbol) ? formatSwapExitEstimate(netWei, token.decimals, token.symbol) : sideFigure(netWei, { decimals: token.decimals, symbol: token.symbol })}`,
  };
}
