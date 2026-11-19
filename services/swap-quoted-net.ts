import { isShareSymbol } from '@/services/share-display';
import type { ShareRate } from '@/services/share-rates';
import { displayUnderlyingWei } from '@/services/share-rates';
import { formatTokenBalanceDown } from '@/services/token-format';
import { formatUnits } from 'viem';

/** The estimated note in underlying units, using the normal token precision. */
export type QuotedNetFigure = { status: 'loading' } | { status: 'ready'; text: string };

export function quotedNetFigure(
  netWei: bigint,
  token: { symbol: string; decimals: number },
  rate: ShareRate | undefined,
): QuotedNetFigure {
  if (isShareSymbol(token.symbol)) {
    if (!rate || rate.shareDecimals !== token.decimals) return { status: 'loading' };
    return { status: 'ready', text: `~${formatTokenBalanceDown(formatUnits(displayUnderlyingWei(netWei, rate), rate.underlyingDecimals), rate.underlyingSymbol)}` };
  }
  return { status: 'ready', text: `~${formatTokenBalanceDown(formatUnits(netWei, token.decimals), token.symbol)}` };
}
