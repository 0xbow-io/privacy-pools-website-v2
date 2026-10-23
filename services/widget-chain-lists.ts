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
