// Chain lists the action widget shows that are not just "every chain this
// build serves". Pure, so the per-flow lists are testable without the config
// graph (bun tests cannot load config/chains).

export interface WidgetNetwork {
  id: number;
  name: string;
  unavailableReason?: string;
}

/**
 * The Swap "You receive" network chips: the destinations that can take this
 * sale, then every other served chain greyed out with why, so a chain with no
 * swaps yet (no RelaySwaps, no LI.FI receiver) is shown rather than missing.
 */
export function swapDestinationNetworks(
  deliverable: readonly number[],
  servedEvmChainIds: readonly number[],
  sourceChainId: number,
  reasonFor: (chainId: number) => string | undefined,
  nameFor: (chainId: number) => string,
): WidgetNetwork[] {
  const live = deliverable.map((id) => ({ id, name: nameFor(id) }));
  const greyed = servedEvmChainIds
    .filter((id) => !deliverable.includes(id))
    .map((id) => ({ id, name: nameFor(id), unavailableReason: id === sourceChainId ? 'Nothing to receive here' : (reasonFor(id) ?? 'No swap route yet') }));
  return [...live, ...greyed];
}

/** Why a held pool cannot be swapped from, or undefined when it can. */
export function swapSourcePoolReason(
  inputSupported: boolean,
  chainReason: string | undefined,
): string | undefined {
  if (inputSupported) return undefined;
  return chainReason ?? 'Not swappable yet';
}

/** The chips shown before the "•••" bubble, in this order (Mike, #276). */
export const PINNED_NETWORK_IDS: readonly number[] = [1, 56, 8453, 4663];

/**
 * Split a chip row into the pinned chips (Ethereum, BNB Chain, Base,
 * Robinhood Chain, those this sheet offers) and the rest, which sit behind
 * the "•••" bubble in list order.
 */
export function splitNetworkChips<T extends WidgetNetwork>(
  networks: readonly T[],
  pinned: readonly number[] = PINNED_NETWORK_IDS,
): { visible: T[]; overflow: T[] } {
  const visible = pinned.flatMap((id) => networks.filter((n) => n.id === id));
  // A sheet offering none of them (staging, Sui) keeps its plain row.
  if (visible.length === 0) return { visible: [...networks], overflow: [] };
  const overflow = networks.filter((n) => !pinned.includes(n.id));
  return { visible, overflow };
}
