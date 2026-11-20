// DEV-828: eligibility and verification for a user-picked community relayer.
// Pure and dependency-free so it tests without the config graph.
import type { CommunityRelayer } from '@/config/community-relayers';

export type RelayerRoute = 'withdraw' | 'yield-redeem' | 'receive-as' | 'swap' | 'batch' | 'transfer';

/**
 * Community relayers serve the plain withdrawal and the yield redemption.
 * Receive-as, swaps and batches keep Fast Relay: a third party has not been
 * checked against those routes. Tor mode hides the option: the relayer is
 * reached over the clear web, which Tor mode exists to avoid.
 */
export function communityRelayerOffered(args: {
  relayer: Pick<CommunityRelayer, 'chainId'>;
  chainId: number | undefined;
  route: RelayerRoute;
  torActive: boolean;
}): boolean {
  if (args.torActive) return false;
  if (args.chainId === undefined || args.relayer.chainId !== args.chainId) return false;
  return args.route === 'withdraw' || args.route === 'yield-redeem';
}

type Contracts = Record<string, string | undefined>;

const same = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/**
 * The relayer's own /v1/details must name the same entrypoint, vault and relay
 * contracts as ours, and the signer it advertises must be the one configured.
 * A relayer that answers for other contracts would bind a proof to an address
 * that can never post it.
 */
export function verifyCommunityDetails(
  details: { id?: number; contracts?: Contracts; relayerAddress?: string },
  ours: { chainId: number; contracts: Contracts },
  relayer: Pick<CommunityRelayer, 'signer'>,
): { ok: true } | { ok: false; reason: string } {
  if (details.id !== ours.chainId) return { ok: false, reason: 'it answered for another chain' };
  for (const key of ['entrypoint', 'poolVault', 'relay'] as const) {
    const expected = ours.contracts[key];
    if (!expected) continue;
    if (!same(details.contracts?.[key], expected)) return { ok: false, reason: `its ${key} contract differs from ours` };
  }
  if (!same(details.relayerAddress, relayer.signer)) return { ok: false, reason: 'its signer is not the one we list' };
  return { ok: true };
}
