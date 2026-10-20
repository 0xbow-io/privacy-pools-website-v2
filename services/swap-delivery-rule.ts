/**
 * What a swap may hand to a WALLET, as a pure rule.
 *
 * Lives here rather than in config/intent-swaps.ts for the usual reason: that
 * module pulls config/environments in, which reaches react-native, and bun
 * tests cannot load it. Same split as services/hub-token-catalog-rule.ts - the
 * rule is testable, the registry wiring stays in config.
 *
 * TWO SOURCES, one list. The configured output table mirrors the ENTRYPOINT's
 * enabled assets, which is the right question for where a DEPOSIT may land and
 * the wrong one for what a wallet may be paid. Once the plain pools were
 * superseded by shares, asking only that question left mainnet offering a
 * single thing to receive: ETH. So every plain asset the chain knows about is
 * added to it (Mike, 2026-09-22: "USDC isn't available as a sending asset").
 *
 * WHAT STAYS OUT: a yield share, and only a yield share. LiFi has to buy and
 * pay out this exact token, and nothing sells a share - that is the 2026-09-04
 * liquidity constraint and this is the list it governs. A SUPERSEDED plain pool
 * is deliberately kept: `superseded` says nobody may deposit into it, not that
 * the coin cannot be handed to an address.
 */

export type DeliveryTokenLike = {
  symbol: string;
  address: string;
  decimals: number;
  isNative?: boolean;
};

export type DeliveryRegistryEntry = {
  symbol: string;
  decimals: number;
  yieldShare?: unknown;
};

/**
 * Merge the configured outputs with the chain's plain registry assets.
 *
 * Order is the contract: configured entries first, in their own order, then
 * the registry ones. The first list is curated and the second is whatever the
 * registry happens to hold, so a curated choice stays at the top of the picker
 * rather than being reshuffled by however the registry object is keyed.
 *
 * `nativeAddress` is passed rather than imported so this file stays free of
 * config, and it is compared case-insensitively because registries key on a
 * lowercased address while the token tables spell it mixed.
 */
export function mergeDeliveryTokens<T extends DeliveryTokenLike>(
  configured: readonly T[],
  registry: Readonly<Record<string, DeliveryRegistryEntry | undefined>>,
  nativeAddress: string,
): DeliveryTokenLike[] {
  const isShare = (address: string) => !!registry[address.toLowerCase()]?.yieldShare;

  const listed = configured.filter((token) => !isShare(token.address));
  const seen = new Set(listed.map((token) => token.address.toLowerCase()));

  const extra: DeliveryTokenLike[] = [];
  for (const [address, entry] of Object.entries(registry)) {
    if (!entry || entry.yieldShare) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    extra.push({
      symbol: entry.symbol,
      address,
      decimals: entry.decimals,
      isNative: key === nativeAddress.toLowerCase(),
    });
  }

  return [...listed, ...extra];
}
