// DEV-828: relayers run by third parties, offered next to Fast Relay.
//
// A community relayer is only ever USER-PICKED. Fast Relay stays the default,
// nothing here is read until the user opens the relayer picker, and a pick is
// checked against our own contract set before any quote is requested
// (services/community-relayer.ts).
import type { Address } from '@/services/sdk-types';

export type CommunityRelayer = {
  id: string;
  /** Shown in the picker. */
  name: string;
  /** Who runs it, for the "run by a third party" line. */
  operator: string;
  chainId: number;
  /** Base URL, no trailing slash. */
  url: string;
  /** The EOA the relayer signs from: the fee receiver the review shows. */
  signer: Address;
};

export const COMMUNITY_RELAYERS: readonly CommunityRelayer[] = [
  {
    id: 'community-ben',
    name: "ben's relayer",
    operator: 'ben',
    chainId: 1,
    url: 'https://80-78-19-4.sslip.io',
    signer: '0x2717d0aAC5E20E6F5da4f0D8F921b269E8ffC4c3' as Address,
  },
];

export function communityRelayersFor(chainId: number | undefined): CommunityRelayer[] {
  if (chainId === undefined) return [];
  return COMMUNITY_RELAYERS.filter((r) => r.chainId === chainId);
}

export function findCommunityRelayer(id: string, chainId: number | undefined): CommunityRelayer | undefined {
  return communityRelayersFor(chainId).find((r) => r.id === id);
}
