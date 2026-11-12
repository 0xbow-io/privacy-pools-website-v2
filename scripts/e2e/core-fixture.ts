import { keccak256, stringToBytes } from 'viem';

/** Recoverable from the funder key + logged run identity, isolated per attempt. */
export function coreFixtureKey(funderKey: string, identity: string): `0x${string}` {
  if (!identity.trim()) throw new Error('Core fixture requires a run identity');
  return keccak256(stringToBytes(`0x${funderKey.replace(/^0x/, '')}:ppv2-e2e-core-v1:${identity}`));
}
