/**
 * Which token a Shield-with-conversion is quoted, sized and displayed in.
 *
 * LiFi is asked to deliver the pool's FUNDING token, not the pool's own token:
 * for a share pool that is the underlying (or the coin, in native mode),
 * because no DEX holds the share and the PPRouter mints it from whatever
 * arrives. So every figure that comes back from that quote — `toAmount`,
 * `toAmountMin`, and the deposit size derived from them — is denominated in the
 * underlying.
 *
 * On mainnet USDC that is 6 decimals against the share's 18, and reading those
 * figures with the pool's decimals divides them by 1e12. Observed on prod
 * 2026-09-22, paying 0.005 ETH (about $13.74) into the USDC pool:
 *
 *   preview   formatUnits(13_740_000, 18)          -> 0.00000000001374, shown as "0"
 *   minimum   13_740_000 < 10_000_000_000_000_000_000 -> "Minimum deposit is 10 USDC"
 *   sizing    formatUnits(target, 18)              -> dust
 *
 * Three symptoms, one cause, and the same shape as `shapeReshieldForDisplay`:
 * the number came from one token and its decimals from another.
 *
 * It only became reachable when share pools became conversion targets
 * (2026-09-21). Before that the funding token WAS the pool token for every
 * conversion, so the two agreed by accident and nothing here was needed.
 *
 * PURE: the deployment is passed in so a bun test can exercise the real rule
 * rather than reproduce it, which is the mistake services/__tests__/
 * shield-pay-routing.test.ts records having made twice.
 */

/** The fields of a yield deployment this rule reads. */
export interface ConversionFundingDeployment {
  underlyingDecimals: number;
  underlyingSymbol: string;
  ppUSDCDecimals: number;
  nativeMode?: boolean;
}

export interface TokenUnits {
  decimals: number;
  symbol: string;
}

/**
 * The units every figure from the conversion quote is in.
 *
 * A plain pool funds itself, so its own units are the funding units. A
 * native-mode router takes the coin, which is 18 decimals like the share, so
 * the pool's units are right there too. Only the wrapped case differs, and it
 * is the only case where the decimals disagree.
 */
export function conversionFundingUnits(
  deployment: ConversionFundingDeployment | null | undefined,
  pool: TokenUnits,
): TokenUnits {
  if (!deployment) return pool;
  if (deployment.nativeMode === true) return { decimals: 18, symbol: pool.symbol };
  return { decimals: deployment.underlyingDecimals, symbol: deployment.underlyingSymbol };
}

/**
 * Is the quoted delivery below the pool's entrypoint minimum?
 *
 * Both arguments must already be in the FUNDING token's units; that is the
 * whole point of the type. `null` for "not yet judged", which is what a
 * still-resolving minimum must read as: treating a pending `previewMint` as a
 * refusal is how a legitimate deposit gets a red line under it.
 */
export function conversionBelowMinimum(
  quotedFundingWei: bigint | null | undefined,
  minFundingWei: bigint | null | undefined,
): boolean {
  if (quotedFundingWei == null || minFundingWei == null || minFundingWei <= 0n) return false;
  return quotedFundingWei < minFundingWei;
}
