import { describe, expect, test } from 'bun:test';

import { resolveYieldDeploymentForAsset, resolveYieldDepositDeploymentForUnderlying } from '@/config/yield';
import type { YieldDeployment } from '@/services/sdk-types';

// Pat, 2026-09-12: "Same for usdt and any asset on any chain that has a
// corresponding ppAsset". The table below is the prod one (mainnet USDC +
// USDT, BNB Chain USDT); the rules under test read it, never a hard-coded
// symbol, so a new pair needs no code change.
const deployments: Record<number, YieldDeployment[]> = {
  1: [
    { ppRouter: '0xe76E793d776c1e207aD7a7fa7C57d27420d85110', ppUSDC: '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6', ppUSDCDecimals: 18, underlying: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', underlyingDecimals: 6, underlyingSymbol: 'USDC' },
    { ppRouter: '0x13a0b86bac3e0C29bd64fED7BCD2EE84f371f41C', ppUSDC: '0xA4cF419558Ef36CC6FfB666195684dC963910426', ppUSDCDecimals: 18, underlying: '0xdAC17F958D2ee523a2206206994597C13D831ec7', underlyingDecimals: 6, underlyingSymbol: 'USDT' },
  ],
  56: [
    { ppRouter: '0x9929Ad2Edc2E0B5D59C3f5b2910812D0c8b84E16', ppUSDC: '0x6C17bE9c864254CA4b2d36223f31AdE94B4d64c2', ppUSDCDecimals: 18, underlying: '0x55d398326f99059fF775485246999027B3197955', underlyingDecimals: 18, underlyingSymbol: 'USDT' },
  ],
};
const FLAGS = { enabled: true, withdrawReady: true };
const verified = () => true;
const unverified = () => false;

// The split this file exists to pin. NAMING (what a picker calls an asset,
// which pool a pick points at) reads the CONFIGURED route: `usable` always
// true. MONEY (what the deposit actually calls) reads the VERIFIED one. Before
// the split, a mainnet USDC row read "Deposits closed" and its destination
// fell through to another pool for as long as the vault probe had not
// answered, on the very screen where picking USDC deposits into ppUSDC.
describe('configured yield route: naming does not wait for the vault probe', () => {
  for (const [chainId, symbol, underlying, share] of [
    [1, 'USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6'],
    [1, 'USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', '0xA4cF419558Ef36CC6FfB666195684dC963910426'],
    [56, 'USDT', '0x55d398326f99059fF775485246999027B3197955', '0x6C17bE9c864254CA4b2d36223f31AdE94B4d64c2'],
  ] as const) {
    test(`${symbol} on chain ${chainId} names its share pool with the probe unanswered`, () => {
      expect(resolveYieldDepositDeploymentForUnderlying(chainId, underlying, FLAGS, deployments, unverified)).toBeUndefined();
      expect(resolveYieldDepositDeploymentForUnderlying(chainId, underlying, FLAGS, deployments, verified)?.ppUSDC).toBe(share);
      // Case is not part of the question: registries and RPC answers disagree
      // about checksumming and both must resolve.
      expect(resolveYieldDepositDeploymentForUnderlying(chainId, underlying.toLowerCase(), FLAGS, deployments, verified)?.ppUSDC).toBe(share);
    });

    test(`${symbol}'s share on chain ${chainId} resolves from either end, so a share-named open finds its underlying`, () => {
      expect(resolveYieldDeploymentForAsset(chainId, share, FLAGS, deployments, verified)?.underlying).toBe(underlying);
      expect(resolveYieldDeploymentForAsset(chainId, underlying, FLAGS, deployments, verified)?.ppUSDC).toBe(share);
    });
  }

  test('a share is never a deposit INPUT, configured or not: 18-decimal shares are not 6-decimal underlying', () => {
    expect(resolveYieldDepositDeploymentForUnderlying(1, '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6', FLAGS, deployments, verified)).toBeUndefined();
  });

  test('an asset with no ppAsset on that chain gets no share pool, on any chain', () => {
    // Mainnet USDC's address on a chain the table does not cover.
    expect(resolveYieldDepositDeploymentForUnderlying(42161, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', FLAGS, deployments, verified)).toBeUndefined();
    expect(resolveYieldDepositDeploymentForUnderlying(1, '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', FLAGS, deployments, verified)).toBeUndefined();
  });

  test('the master flags still close everything: configured is not a way around them', () => {
    for (const flags of [{ enabled: false, withdrawReady: true }, { enabled: true, withdrawReady: false }]) {
      expect(resolveYieldDepositDeploymentForUnderlying(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', flags, deployments, verified)).toBeUndefined();
    }
  });
});
