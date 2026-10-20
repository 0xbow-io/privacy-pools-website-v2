import { displayTokenSymbol, isShareSymbol } from './share-display';

/**
 * Pool URLs, picker labels and row visibility once a chain has BOTH a yield
 * share pool and the plain pool it superseded.
 *
 * Mainnet 2026-09-18: ppETH opened and every new ETH deposit is wrapped into
 * it, so the plain ETH pool only exists for the notes already in it. The user
 * never chose "ppETH" (Ameen: no pp asset is named to the user) and the URL
 * is part of the name, so:
 *
 *   share pool   ppETH  → slug `eth`,        label "ETH"
 *   legacy plain ETH    → slug `eth-legacy`, label "ETH (legacy)"
 *
 * A plain pool is LEGACY when its deposits are closed (`withdrawOnly`) or are
 * redirected into a share pool on the same chain (the native coin with a
 * native-mode yield router, or an ERC-20 that is a configured yield
 * underlying). A plain pool that is still open keeps its slug, and a share
 * whose display name would collide with such an open pool keeps its raw
 * symbol in the URL rather than being ambiguous.
 *
 * Pure: the per-chain inventory is passed in (config/pool-paths.ts builds it),
 * so bun can pin every branch without touching config/chains.
 */
export type PoolSlugContext = {
  /** Upper-case share symbols configured on the chain (e.g. PPETH, PPUSDC). */
  shareSymbols: readonly string[];
  /** Upper-case plain pool symbols still open for deposits. */
  openPlainSymbols: readonly string[];
  /** Upper-case plain pool symbols whose deposits are closed or redirected. */
  legacyPlainSymbols: readonly string[];
};

export const LEGACY_SLUG_SUFFIX = '-legacy';

const up = (s: string) => s.toUpperCase();

/** The share on the chain that DISPLAYS as `display` (ppETH for ETH), if any. */
function shareDisplayedAs(display: string, ctx: PoolSlugContext): string | undefined {
  return ctx.shareSymbols.find((s) => up(displayTokenSymbol(s)) === display);
}

/**
 * A plain pool whose deposits now land in a share pool on the same chain: the
 * legacy ETH pool once ppETH opened. Its notes stay spendable (My balances,
 * /eth-legacy), but a pool DIRECTORY (Explore, the home list) shows the share
 * in its place rather than two rows called ETH with the empty one on top.
 */
export function isSupersededPlainPool(symbol: string, ctx: PoolSlugContext): boolean {
  const symbolUpper = up(symbol);
  return !isShareSymbol(symbolUpper)
    && ctx.legacyPlainSymbols.includes(symbolUpper)
    && shareDisplayedAs(symbolUpper, ctx) !== undefined;
}

/** URL segment for a pool symbol on the chain described by `ctx`. */
export function poolSlug(symbol: string, ctx: PoolSlugContext): string {
  const U = up(symbol);
  if (isShareSymbol(U)) {
    const display = up(displayTokenSymbol(U));
    // The coin's own name is the share's URL unless a still-open plain pool
    // of that name exists on the chain; then the raw symbol stays, unambiguous.
    return (ctx.openPlainSymbols.includes(display) ? U : display).toLowerCase();
  }
  if (isSupersededPlainPool(U, ctx)) return `${U.toLowerCase()}${LEGACY_SLUG_SUFFIX}`;
  return symbol.toLowerCase();
}

/** Upper-case token symbol a URL segment names on the chain described by `ctx`. */
export function poolSymbolFromSlug(slug: string, ctx: PoolSlugContext): string {
  const s = slug.toLowerCase();
  if (s.endsWith(LEGACY_SLUG_SUFFIX)) return up(s.slice(0, -LEGACY_SLUG_SUFFIX.length));
  const U = up(s);
  const share = shareDisplayedAs(U, ctx);
  // `eth` is the share when the plain ETH pool is legacy or absent; an open
  // plain pool of that name keeps the segment (and the share keeps its raw one).
  if (share && !ctx.openPlainSymbols.includes(U)) return share;
  return U;
}

/** Picker / list label: the coin, with "(legacy)" on a superseded plain pool. */
export function poolLabel(symbol: string, ctx: PoolSlugContext): string {
  const U = up(symbol);
  if (isSupersededPlainPool(U, ctx)) return `${displayTokenSymbol(symbol)} (legacy)`;
  return displayTokenSymbol(symbol);
}

/**
 * A balances row for a legacy pool the user has emptied (ragequit or withdrew
 * everything) says nothing they can act on: deposits are closed, so it is
 * dropped. Any balance or pending amount keeps the row.
 */
export function hideEmptyLegacyRow(balanceRaw: bigint, pendingRaw: bigint, legacy: boolean): boolean {
  return legacy && balanceRaw === 0n && pendingRaw === 0n;
}

/**
 * A My private balance row with nothing in it: no spendable balance, nothing
 * pending, and no other live note (a REJECTED note is still the user's money,
 * at risk). Any pool kind, not only legacy (Mike, DEV-466). Dust is not empty:
 * it is a positive balance and renders as "<0.01". The row returns as soon as
 * the pool holds anything again.
 */
export function hideEmptyBalanceRow(balanceRaw: bigint, pendingRaw: bigint, holdsOtherLiveNote: boolean): boolean {
  return balanceRaw === 0n && pendingRaw === 0n && !holdsOtherLiveNote;
}

/** What `visibleSwapSources` needs to know about one candidate source asset. */
export type SwapSourceHolding = {
  balanceRaw: bigint;
  pendingRaw: bigint;
  legacy: boolean;
};

/**
 * Source assets a swap form should offer, under the same rule the balances
 * list uses: a legacy pool the user has emptied is not something they can swap
 * from, so offering it is a dead chip. Any balance or pending amount keeps it,
 * and an open pool is always offered whether or not it is funded (the form's
 * own over-balance gate says the rest).
 *
 * Pure and generic so the caller owns both the candidate list and where the
 * holdings come from; `hideEmptyLegacyRow` above is the shared rule.
 */
export function visibleSwapSources<T>(
  tokens: readonly T[],
  holdingOf: (token: T) => SwapSourceHolding,
): T[] {
  return tokens.filter((token) => {
    const held = holdingOf(token);
    return !hideEmptyLegacyRow(held.balanceRaw, held.pendingRaw, held.legacy);
  });
}
