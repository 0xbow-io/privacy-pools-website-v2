import { formatUnits } from 'viem';

import { capText } from '@/services/send-amount-rules';
import { isShareSymbol, plainTokenFigure } from '@/services/share-display';
import { shareWeiText, type ShareRate } from '@/services/share-rates';

/**
 * A figure in the selected note's units as the Send form shows it (amount,
 * remaining, limits). A share is the underlying at `rate`, written by
 * `shareFigure` (the amount field's writer) when given; a plain STABLECOIN is
 * two decimals cut down ("1.00 USDC", 2.999 is "2.99"), the same rule as the
 * balance views (DEV-621); every other plain token keeps its exact figure.
 * Display only: callers keep the exact wei.
 */
export function noteFigureText(
  wei: bigint,
  units: { symbol: string; decimals: number },
  rate: ShareRate | undefined,
  options: { shareFigure?: (exact: string) => string | null; cap?: { enteredWei: bigint } } = {},
): string {
  const { shareFigure, cap } = options;
  const exactText = (v: bigint, d: number) => formatUnits(v, d);
  const capped = cap
    ? (v: bigint, d: number) => (d === units.decimals ? capText(v, cap.enteredWei, d) : capText(v, v + 1n, d))
    : exactText;
  return shareFigure?.(formatUnits(wei, units.decimals))
    ?? shareWeiText(wei, units, rate, (v, d, sym) => (isShareSymbol(units.symbol) ? capped(v, d) : plainTokenFigure(capped(v, d), sym)));
}
