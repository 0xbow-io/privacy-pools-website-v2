/**
 * Compare two token or pool symbols.
 *
 * Four of the nine symbols this app ships are MIXED CASE: `cBTC`, `ppETH`,
 * `ppUSDC`, `ppUSDT`. A comparison that uppercases one side and then uses
 * `===` can never match any of them:
 *
 *   'ppETH'.toUpperCase() === 'ppETH'   // false
 *   'CBTC' === 'cBTC'                   // false
 *
 * That shape was written in a dozen places while every symbol was uppercase and
 * it was harmless. It stopped being harmless the moment share pools became
 * selectable, on 2026-09-22:
 *
 *   the swap form found no pool for 'ppETH', so the balance read 0n and every
 *   amount was "more than you have shielded here" (Mike, on a shielded 0.005
 *   ETH, typing 0.003)
 *
 *   the same user's cBTC balance was wrong in the same breath, for the same
 *   reason and with no share involved at all
 *
 *   the swap hand-off refused every share with "Swapping USDC is not available
 *   on this network" (#99, same morning, three sites)
 *
 * So symbols are compared here and only here. Case never decides whether two
 * names are the same name.
 *
 * This is for EQUALITY of names. It is not an identity check: `displayTokenSymbol`
 * renders ppETH as "ETH", which is also the legacy plain ETH pool, so two pools
 * can share a display name. Where the question is "which pool", compare
 * addresses — see services/swap-token-handoff.ts.
 */

/** True when two symbols name the same asset, whatever their case. */
export function sameSymbol(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** `sameSymbol`, curried for `.find()` / `.some()` over rows keyed by name. */
export function bySymbol<T extends { name: string }>(symbol: string | null | undefined) {
  return (row: T): boolean => sameSymbol(row.name, symbol);
}
