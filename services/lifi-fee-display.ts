import type { SwapQuoteResult } from '@privacy-pools-v2/sdk';
import { formatUnits } from 'viem';
import { formatCopyAmount } from './token-format';

/** Informational fees from the Review quote; never subtract these from its output. */
export function lifiFeeText(costs: SwapQuoteResult['feeCosts']): string | null {
  if (!costs) return null;
  const totals = new Map<string, { amount: bigint; symbol: string; decimals: number }>();
  for (const cost of costs) {
    const amount = cost.feeSplit?.lifiFee ?? (/^LIFI\b/i.test(cost.name) ? cost.amount : undefined);
    if (amount === undefined) continue; // Bridge, DEX and integrator charges are not LI.FI fees.
    if (!/^\d+$/.test(amount) || !Number.isInteger(cost.token.decimals) || cost.token.decimals < 0 || cost.token.decimals > 255) return null;
    const key = `${cost.token.chainId}:${cost.token.address.toLowerCase()}`;
    const previous = totals.get(key);
    totals.set(key, { amount: (previous?.amount ?? 0n) + BigInt(amount), symbol: cost.token.symbol, decimals: cost.token.decimals });
  }
  if (!totals.size) return '0';
  return [...totals.values()].map(({ amount, symbol, decimals }) =>
    `${formatCopyAmount(Number(formatUnits(amount, decimals)), symbol, 'up')} ${symbol}`,
  ).join(' + ');
}
