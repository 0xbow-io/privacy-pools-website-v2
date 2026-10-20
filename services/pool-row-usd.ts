/**
 * The dollar value of one balances row, and therefore of the hero total above
 * it, because they must be the same arithmetic.
 *
 * A yield share cannot be priced by its own symbol. There is no "ppETH" in the
 * price feed and there never will be: a share is worth its UNDERLYING at the
 * live vault rate. Pricing it by symbol falls through to the stablecoin floor,
 * which is 0 for anything that is not a stablecoin.
 *
 * Observed on prod, 2026-09-22. "My private balance" read $9 over rows of
 * cBTC $9, ETH $14 and USDC $0:
 *
 *   the card  priced each share row as converted-to-underlying x underlying
 *             price, so the ETH row correctly showed $14
 *   the total summed the provider's figure, which priced 'ppETH' by symbol,
 *             got nothing, fell to the 0 floor, and counted the row as zero
 *
 * So the hero was the sum of the rows it did NOT show: cBTC alone. For anyone
 * holding only shares, which is everyone since ppETH and ppUSDC opened, the
 * headline number read far below the truth.
 *
 * pools-provider already carried a comment saying the hero must be the sum of
 * the rows, after an earlier version re-derived it separately and disagreed.
 * The same disagreement came back by another route: the ROWS learned about
 * shares and the total did not. So the conversion lives here, once, and both
 * read it.
 *
 * PURE: the rate and the price are passed in, so a bun test drives the real
 * rule rather than a copy of it.
 */
import { shareNumberAsUnderlying, underlyingPriceFor, type ShareRate } from '@/services/share-rates';

export interface RowUsdInput {
  /** Token quantity, already scaled out of base units. */
  amount: number;
  /** The live vault rate, when this row is a share and the rate has loaded. */
  rate?: ShareRate | undefined;
  /** Price for a PLAIN asset; ignored for a share, which prices its underlying. */
  plainPrice: number;
  priceMap: Record<string, number> | undefined;
}

/**
 * Dollars for one row.
 *
 * A share with a loaded rate is converted to its underlying and priced there.
 * Anything else keeps the caller's plain price, including a share whose rate
 * has not arrived yet: that reads 0 for a moment and then corrects, which is
 * the same thing the row itself does, and is honest in a way that guessing
 * shares-times-underlying-price would not be.
 */
export function rowUsd(input: RowUsdInput): number {
  if (!Number.isFinite(input.amount)) return 0;
  if (input.rate) {
    const price = underlyingPriceFor(input.rate, input.priceMap);
    if (price > 0) return shareNumberAsUnderlying(input.amount, input.rate) * price;
    // No underlying price yet: 0 rather than the share's own price, which is
    // not a price for this quantity at all.
    return 0;
  }
  const value = input.amount * input.plainPrice;
  return Number.isFinite(value) ? value : 0;
}
