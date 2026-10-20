// Entrypoint resolution — the staging pin vs the ASP feed.
//
// The scenario that motivated the pin is real, not hypothetical: the ASP's
// chain-10 (OP mainnet) row shipped with "entrypoint" set to the POOL VAULT
// and "poolVault" set to an unrelated contract (2026-08-13). Feed-first
// resolution would fall back to that row (no vault match) and hand the vault
// address to the SDK as the entrypoint — every deposit reverts at simulation.
// These tests pin the exact scenario plus the non-staging paths that must
// keep trusting the feed.

import { describe, expect, test } from 'bun:test';
import { resolveEntrypointChainConfig } from '../entrypoint-resolution';
import type { EntrypointsResponse } from '../api-types';
import type { StagingDeployment } from '../../config/staging-deployments';

const OP_ENTRYPOINT = '0x4A20b3ae656339b9707C61992dCdA642366D3004';
const OP_POOL = '0x02a1E00294291d0E938eC92A8c2883044524ec4B';

const opStaging = {
  chainId: 10,
  name: 'optimism',
  displayName: 'Optimism',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  explorerUrl: 'https://optimistic.etherscan.io',
  explorerName: 'Etherscan',
  rpcUrl: 'https://mainnet.optimism.io',
  pool: OP_POOL,
  keystore: '0x4BeCb4c0175Df3dA440A694E73Fd3c459B8dd422',
  aspRegistry: '0x8240695D24746D6ED38E9a4EEF57EF78b33158f4',
  entrypoint: OP_ENTRYPOINT,
  accessRouter: '0x08806e1aD685FbF518dfa6795b90ca4c1F04Cd64',
  relay: '0x55DC6ADe57F3243c659cFe045F591C011924fECc',
  fromBlock: 155397570n,
  keystoreFromBlock: 155397570n,
  relayerBaseUrl: 'https://relayer.example',
} satisfies StagingDeployment;

// The REAL wrong feed row the ASP served for chain 10: entrypoint is the
// pool vault, poolVault is an unrelated contract.
const wrongOpFeed: EntrypointsResponse = {
  pools: [
    { poolId: '8', chainId: '10', entrypoint: OP_POOL.toLowerCase(), poolVault: '0x8884dc0c0decd2558f128ee00dd522abfa21dd52', fromBlock: 155397570 },
  ],
  cacheTimestamp: '',
};

const sepoliaFeed: EntrypointsResponse = {
  pools: [
    { poolId: '1', chainId: '11155111', entrypoint: '0xaaa1000000000000000000000000000000000001', poolVault: '0xbbb1000000000000000000000000000000000001', fromBlock: 100 },
    { poolId: '2', chainId: '11155111', entrypoint: '0xaaa2000000000000000000000000000000000002', poolVault: '0xbbb2000000000000000000000000000000000002', fromBlock: 200 },
  ],
  cacheTimestamp: '',
};

describe('resolveEntrypointChainConfig', () => {
  test('a staging chain is PINNED. The wrong feed row cannot poison it', () => {
    const resolved = resolveEntrypointChainConfig(wrongOpFeed, 10, OP_POOL, { 10: opStaging });
    expect(resolved?.entrypoint).toBe(OP_ENTRYPOINT);
    expect(resolved?.poolVault).toBe(OP_POOL);
    // Without the pin, the same call trusts the feed and returns the vault
    // address as the entrypoint — the deposits-revert bug this guards.
    const unpinned = resolveEntrypointChainConfig(wrongOpFeed, 10, OP_POOL, {});
    expect(unpinned?.entrypoint).toBe(OP_POOL.toLowerCase());
  });

  test('the pin applies even when the feed has NO row for the chain', () => {
    const resolved = resolveEntrypointChainConfig({ pools: [], cacheTimestamp: '' }, 10, OP_POOL, { 10: opStaging });
    expect(resolved?.entrypoint).toBe(OP_ENTRYPOINT);
  });

  test('non-staging chains keep matching the feed by pool vault', () => {
    const resolved = resolveEntrypointChainConfig(
      sepoliaFeed,
      11155111,
      '0xBBB2000000000000000000000000000000000002', // case-insensitive match
      { 10: opStaging },
    );
    expect(resolved?.entrypoint).toBe('0xaaa2000000000000000000000000000000000002');
  });

  test('non-staging chains fall back to the first on-chain pool without a vault', () => {
    const resolved = resolveEntrypointChainConfig(sepoliaFeed, 11155111, undefined, {});
    expect(resolved?.poolId).toBe('1');
  });

  test('unknown chain with no staging entry resolves to undefined', () => {
    expect(resolveEntrypointChainConfig(sepoliaFeed, 999, undefined, {})).toBeUndefined();
  });
});
