/**
 * Merge the per-chain price maps the scheduler keeps warm into the one map a
 * screen reads.
 *
 * WHY THIS EXISTS: three screens used to call `getAllPrices()` with no chainId.
 * That is a real request — the module cache keys an UNSCOPED entry the public
 * feed scheduler never warms, so those `useQuery`s fetched on mount and on
 * every window focus past their staleTime. The focus that matters is the one
 * that lands when the user comes back from signing in their wallet, which puts
 * ASP and Alchemy traffic either side of a transaction.
 *
 * The fix is not a mandatory chainId (a screen can still mint an unwarmed
 * scope, and `pool-page-content` does, with SUI) and not an extra unscoped
 * feed (strictly redundant traffic: the unscoped response is every chain's rows,
 * which the per-chain feeds already carry between them). It is to read what is
 * already on the grid and join it here — bulk feeds, merged locally, the same
 * shape as every other public read in this app.
 *
 * COLLISIONS: the per-chain maps are keyed by bare symbol and by bare address,
 * neither of which is chain-qualified, so two chains can disagree about "USDC"
 * — and every EVM chain here shares ONE native sentinel address
 * (0xEeee…EEeE), so "the native token" collides on every chain at once. A
 * screen that lists one chain wants the bare keys with the active chain
 * applied LAST and winning. A screen that lists SEVERAL chains in one list
 * must not: pricing a Citrea CBTC row at mainnet ETH's number is the wrong
 * figure, not an approximation.
 *
 * So the merged map carries BOTH: the bare keys (active chain wins, for
 * single-chain screens) and a `${chainId}:${key}` entry for every row, which
 * cannot collide. Cross-chain lists read the qualified key first and fall back
 * to the bare one; `priceFromMap` is that lookup, so no caller has to
 * reimplement the order.
 */
export type PriceMapEntry = { chainId: number; prices: Readonly<Record<string, number>> | null };

export const EMPTY_PRICE_MAP: Readonly<Record<string, number>> = Object.freeze({});

// The native sentinel every EVM chain shares (config/environments.ts
// NATIVE_ASSET_ADDRESS, restated so this module stays import-free).
const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

/** The non-colliding key: one chain's reading of one symbol or address. */
export function qualifiedPriceKey(chainId: number, token: string): string {
  return `${chainId}:${token}`;
}

/**
 * The price for one row of a list that may span chains. Tries the row's own
 * chain first (address, then symbol), and only then the bare keys — so a row
 * whose chain reported a price never inherits another chain's.
 *
 * The bare native sentinel is never a fallback for a row with a chain: under it
 * sits whichever chain's native coin was merged last, so a BNB row on a screen
 * where Ethereum is active read ETH's price. Its symbol ("BNB") still is.
 *
 * Zero is the ASP's testnet reading for "unknown" and is not a price.
 */
export function priceFromMap(
  map: Readonly<Record<string, number>>,
  row: { chainId?: number; address?: string; symbol?: string },
): number | undefined {
  const address = row.address?.toLowerCase();
  const symbols = row.symbol ? [row.symbol.toUpperCase(), row.symbol] : [];
  const keys: string[] = [];
  if (row.chainId !== undefined) {
    if (address) keys.push(qualifiedPriceKey(row.chainId, address));
    for (const symbol of symbols) keys.push(qualifiedPriceKey(row.chainId, symbol));
  }
  if (address && !(row.chainId !== undefined && address === NATIVE_SENTINEL)) keys.push(address);
  keys.push(...symbols);
  for (const key of keys) {
    const price = map[key];
    if (typeof price === 'number' && price > 0) return price;
  }
  return undefined;
}

export function mergePriceMaps(
  entries: readonly PriceMapEntry[],
  activeChainId?: number,
): Readonly<Record<string, number>> {
  const ordered = activeChainId === undefined
    ? entries
    // Stable apart from moving the active chain to the end, so the result does
    // not depend on the order the feeds happened to be registered in.
    : [...entries.filter((e) => e.chainId !== activeChainId), ...entries.filter((e) => e.chainId === activeChainId)];

  let merged: Record<string, number> | null = null;
  for (const entry of ordered) {
    if (!entry.prices) continue;
    for (const [token, price] of Object.entries(entry.prices)) {
      // A feed that has not answered yet contributes nothing; a zero or NaN
      // price is not a price, and letting one through would render "$0.00" for
      // a real balance.
      if (!Number.isFinite(price) || price <= 0) continue;
      merged ??= {};
      merged[token] = price;
      // The chain-qualified twin. Written from the SAME row, so a chain can
      // never be credited with a price it did not report.
      merged[qualifiedPriceKey(entry.chainId, token)] = price;
    }
  }
  // One frozen empty object rather than a fresh {} per call: this feeds a
  // useSyncExternalStore snapshot, where a new identity every read is an
  // infinite render loop.
  return merged ?? EMPTY_PRICE_MAP;
}
