// DEV-828: the check run when a user picks a community relayer, before any
// quote is requested from it. It asks the relayer for its own /v1/details (a
// route the egress policy already allows) and compares the contracts with ours.
import type { CommunityRelayer } from '@/config/community-relayers';
import { ACTIVE_DEPLOYMENTS_BY_CHAIN } from '@/config/environments';
import { verifyCommunityDetails } from '@/services/community-relayer';

type DetailsReader = {
  getChainDetails: (relayer: never) => Promise<unknown>;
};

export async function assertCommunityRelayer(
  chainId: number,
  community: CommunityRelayer,
  interactor: DetailsReader,
  relayerRecord: unknown,
): Promise<void> {
  const deployment = ACTIVE_DEPLOYMENTS_BY_CHAIN[chainId];
  if (!deployment) throw new Error(`${community.name} is not available on this chain. Nothing was sent.`);
  let details: Parameters<typeof verifyCommunityDetails>[0];
  try {
    details = (await interactor.getChainDetails(relayerRecord as never)) as typeof details;
  } catch {
    throw new Error(`${community.name} did not answer. Switch to Fast Relay or try again. Nothing was sent.`);
  }
  const verdict = verifyCommunityDetails(
    details,
    {
      chainId,
      contracts: { entrypoint: deployment.entrypoint, relay: deployment.relay },
    },
    community,
  );
  if (!verdict.ok) {
    throw new Error(`${community.name} cannot be used: ${verdict.reason}. Switch to Fast Relay. Nothing was sent.`);
  }
}
