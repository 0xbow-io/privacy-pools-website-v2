import { isShareSymbol, tokenAmountLabel } from '@/services/share-display';
import { formatTokenBalanceDown } from '@/services/token-format';

/** Display only: plain spendable balances must never round above the cap.
 * Share pools keep the underlying display boundary (and its share hint).
 */
export function spendableBalanceLabel(exact: string, symbol: string, shareDisplay: () => string): string {
  return isShareSymbol(symbol) ? shareDisplay() : tokenAmountLabel(formatTokenBalanceDown(exact, symbol), symbol);
}
