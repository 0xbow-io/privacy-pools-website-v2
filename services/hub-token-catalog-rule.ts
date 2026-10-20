// The per-tab token rule of the hub, pure: which of a chain's registry
// entries each tab OFFERS. No registry import here (config/tokens pulls
// react-native in, which bun tests cannot load); services/hub-token-catalog.ts
// feeds it the registry lists.
//
// The hub keeps one selected token across tabs and resets a selection the
// current tab does not offer to the native asset, so these lists decide what
// survives a tab switch (Pat, 2026-09-05: ppUSDC picked for Withdraw came
// back as the Shield pay token; USDC picked for Shield came back as the
// Withdraw source).
//
//   shield    what the wallet pays IN. A yield share (ppUSDC) is never paid
//             in: the PPRouter mints it from its underlying. So shares are
//             out even though the registry lists them as pools.
//   withdraw  what the account HOLDS shielded here, plus the native asset as
//   send      the resting default only when it is not superseded. Until the holdings are KNOWN (a cache or a
//             completed sync for this chain) the full actionable list stands,
//             so a legitimate pick is not reset to ETH by an empty "not loaded
//             yet" set and then lost when the balances arrive (codex P2).
//   request   what a plain Entrypoint deposit may pay.
//   swap      every actionable asset EXCEPT a superseded plain pool.
//
// A superseded plain pool (legacy ETH once ppETH opened) appears on WITHDRAW
// and nowhere else (Pat, 2026-09-22). Shield already excluded it, because
// resolveDepositableTokens drops withdraw-only assets; swap and send exclude it
// here. Withdraw keeps it, and only when it is funded, because that is the one
// thing a legacy holder still needs to do with it.

export type HubAction = 'shield' | 'withdraw' | 'send' | 'swap' | 'request';

export type HubHoldings = {
  /** Upper-cased symbols with active or pending shielded funds on the chain. */
  symbols: ReadonlySet<string>;
  /** False while those holdings are not loaded yet (see pools-provider). */
  ready: boolean;
};

export const NO_HOLDINGS: HubHoldings = { symbols: new Set(), ready: true };

export type HubTokenLike = { symbol: string; isNative: boolean; yieldShare?: unknown; superseded?: boolean };

/** The registry lists for one chain, as config/tokens produces them. */
export type HubCatalogSource<T extends HubTokenLike> = {
  /** getActionableTokens(chainId) */
  actionable: readonly T[];
  /** getDepositableTokens(chainId) */
  depositable: readonly T[];
  /** getEntrypointDepositableTokens(chainId) */
  entrypointDepositable: readonly T[];
};

export function selectHubTokens<T extends HubTokenLike>(action: HubAction, source: HubCatalogSource<T>, holdings: HubHoldings): T[] {
  switch (action) {
    case 'shield':
      return source.depositable.filter((t) => !t.yieldShare);
    case 'withdraw':
      if (!holdings.ready) return [...source.actionable];
      // The one tab a superseded pool survives on, and only when funded: it is
      // how a legacy holder gets their money out.
      return source.actionable.filter((t) => (t.isNative && !t.superseded) || holdings.symbols.has(t.symbol.toUpperCase()));
    case 'send':
      // Withdraw only (Pat, 2026-09-22). A legacy holder sends by withdrawing;
      // offering the pool here keeps a closed asset circulating through a
      // surface that should be moving people onto the live one.
      //
      // Filtered BEFORE the holdings gate as well, so the "not loaded yet"
      // branch cannot show it for a moment and then take it away.
      if (!holdings.ready) return source.actionable.filter((t) => !t.superseded);
      return source.actionable.filter((t) => !t.superseded
        && (t.isNative || holdings.symbols.has(t.symbol.toUpperCase())));
    case 'request':
      return source.entrypointDepositable.filter((t) => !t.superseded);
    case 'swap':
      // A superseded plain pool is never a swap source, held or not (Pat,
      // 2026-09-22). WITHDRAW is the only tab that still offers it, and only
      // when it is funded, which is how a legacy ETH holder gets their money
      // out. Send used to as well; it does not any more (see above).
      //
      // Unconditional, unlike the withdraw case above: offering it only when
      // empty-and-hidden would leave a chip that appears the moment someone has
      // a legacy balance, which is exactly the state this removes it for.
      return source.actionable.filter((t) => !t.superseded);
    default:
      return [...source.actionable];
  }
}

/** Active or pending funds on `chainId`, preserving legacy access. */
export function heldSymbolsFor(
  pools: readonly { chainId: number; name: string; balanceTokenExact: string; pendingTokenExact?: string }[],
  chainId: number,
): Set<string> {
  return new Set(
    pools
      .filter((p) => p.chainId === chainId && ((parseFloat(p.balanceTokenExact) || 0) > 0 || (parseFloat(p.pendingTokenExact ?? '0') || 0) > 0))
      .map((p) => p.name.toUpperCase()),
  );
}

/** Once balances arrive, an empty resting selection yields to a held source. */
export function preferredHubToken<T extends HubTokenLike>(tokens: readonly T[], holdings: HubHoldings): T | undefined {
  if (holdings.ready) {
    const held = tokens.filter((t) => holdings.symbols.has(t.symbol.toUpperCase()));
    return held.find((t) => t.yieldShare) ?? held[0] ?? tokens.find((t) => !t.superseded);
  }
  return tokens.find((t) => !t.superseded);
}
