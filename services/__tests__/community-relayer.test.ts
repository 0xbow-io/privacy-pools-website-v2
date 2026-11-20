import { describe, expect, test } from 'bun:test';
import { communityRelayerOffered, verifyCommunityDetails } from '../community-relayer';

const relayer = { chainId: 1, signer: '0x2717d0aAC5E20E6F5da4f0D8F921b269E8ffC4c3' as `0x${string}` };
const ours = {
  chainId: 1,
  contracts: {
    entrypoint: '0xca1e072236D231130059eeA6Bfceb7F4e9a1F0C3',
    poolVault: '0x0Eb42804BF897662aF851370eaeAdcDBEC1b97ed',
    relay: '0x01a8Fa4dbb60187aD8d3c3d08E7Fb8C14198A461',
  },
};
const good = { id: 1, contracts: { ...ours.contracts }, relayerAddress: relayer.signer };

describe('communityRelayerOffered', () => {
  const base = { relayer, chainId: 1, route: 'withdraw' as const, torActive: false };
  test('offered on its chain for a plain withdrawal and a yield redemption', () => {
    expect(communityRelayerOffered(base)).toBe(true);
    expect(communityRelayerOffered({ ...base, route: 'yield-redeem' })).toBe(true);
  });
  test('not on another chain', () => expect(communityRelayerOffered({ ...base, chainId: 8453 })).toBe(false));
  test('not for receive-as, swap, batch or transfer', () => {
    for (const route of ['receive-as', 'swap', 'batch', 'transfer'] as const) {
      expect(communityRelayerOffered({ ...base, route })).toBe(false);
    }
  });
  test('hidden in Tor mode', () => expect(communityRelayerOffered({ ...base, torActive: true })).toBe(false));
});

describe('verifyCommunityDetails', () => {
  test('accepts matching contracts, case-insensitive', () => {
    expect(verifyCommunityDetails({ ...good, relayerAddress: relayer.signer.toLowerCase() }, ours, relayer).ok).toBe(true);
  });
  test('refuses a different relay contract', () => {
    const r = verifyCommunityDetails(
      { ...good, contracts: { ...good.contracts, relay: '0x0000000000000000000000000000000000000001' } },
      ours,
      relayer,
    );
    expect(r).toEqual({ ok: false, reason: 'its relay contract differs from ours' });
  });
  test('refuses another chain and another signer', () => {
    expect(verifyCommunityDetails({ ...good, id: 10 }, ours, relayer).ok).toBe(false);
    expect(
      verifyCommunityDetails({ ...good, relayerAddress: '0x0000000000000000000000000000000000000002' }, ours, relayer).ok,
    ).toBe(false);
  });
});
