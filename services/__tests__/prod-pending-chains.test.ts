// The 2026-10-14 prod chains (Optimism, Base, Arbitrum One, Robinhood Chain):
// on by default (Pat), wired like mainnet, and kept out of the cold-start
// allow-list until the prod relayer serves register-and-relay there.

import { describe, expect, test } from 'bun:test';
import { ALL_PROD_CHAINS, ALL_PROD_YIELD_DEPLOYMENTS } from '../../config/prod-deployments';
import { ENVIRONMENTS } from '../../config/environments';
import { supportsColdStartClaim } from '../../config/cold-start';

const NEW_CHAINS = [10, 8453, 42161, 4663];

describe('prod 2026-10-14 chains', () => {
  test('served by default, Ethereum first', () => {
    const prod = ENVIRONMENTS.prod;
    expect(prod.deployments.map((d) => d.chainId)).toEqual([1, 4114, 56, ...NEW_CHAINS]);
    for (const id of NEW_CHAINS) {
      expect(prod.deploymentsByChain[id]).toBeDefined();
      expect(prod.tokensByChain[id]).toBeDefined();
      expect(prod.lifiServedChainIds).toContain(id);
    }
    expect(prod.lifiServedChainIds).not.toContain(4114);
  });

  test('every deployment shares the deterministic core addresses; RelaySwaps on 10, 8453, 42161, none on Robinhood', () => {
    const first = ALL_PROD_CHAINS[0];
    for (const d of ALL_PROD_CHAINS) {
      expect(d.pool).toBe(first.pool);
      expect(d.entrypoint).toBe(first.entrypoint);
      expect(d.keystore).toBe(first.keystore);
      expect(d.relay).toBe(first.relay);
      expect(d.fromBlock > 0n).toBe(true);
    }
    for (const id of [10, 8453, 42161]) {
      expect(ALL_PROD_CHAINS.find((c) => c.chainId === id)?.relaySwaps).toBe(first.relaySwaps);
    }
    expect(ALL_PROD_CHAINS.find((c) => c.chainId === 4663)?.relaySwaps).toBeUndefined();
  });

  test('cold start stays off until the relayer serves the route', () => {
    for (const id of NEW_CHAINS) expect(supportsColdStartClaim(id, ALL_PROD_CHAINS[0].relay)).toBe(false);
  });

  test('each yield entry names a share the prod registry knows, and its underlying', () => {
    const tokens = ENVIRONMENTS.prod.tokensByChain;
    for (const id of NEW_CHAINS) {
      for (const d of ALL_PROD_YIELD_DEPLOYMENTS[id] ?? []) {
        const share = tokens[id]?.[d.ppUSDC.toLowerCase()];
        expect(share?.yieldShare).toBe('aave-v3');
        expect(share?.decimals).toBe(18);
        if (d.nativeMode) {
          expect(tokens[id]['0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee']?.isNative).toBe(true);
        } else {
          expect(tokens[id]?.[d.underlying.toLowerCase()]?.decimals).toBe(d.underlyingDecimals);
        }
      }
    }
    expect(ALL_PROD_YIELD_DEPLOYMENTS[4663]).toBeUndefined();
  });

  test('plain pool rule: a plain asset with a share on the same chain is withdraw-only', () => {
    const tokens = ENVIRONMENTS.prod.tokensByChain;
    for (const id of NEW_CHAINS) {
      const underlyings = new Set(
        (ALL_PROD_YIELD_DEPLOYMENTS[id] ?? []).filter((d) => !d.nativeMode).map((d) => d.underlying.toLowerCase()),
      );
      for (const token of Object.values(tokens[id] ?? {})) {
        if (underlyings.has(token.address.toLowerCase())) expect(token.withdrawOnly).toBe(true);
      }
    }
    // Share-less plain pools stay open: Base USDT, Robinhood USDG.
    expect(tokens[8453]['0xfde4c96c8593536e31f229ea8f37b2ada2699bb2']?.withdrawOnly).toBeUndefined();
    expect(tokens[4663]['0x5fc5360d0400a0fd4f2af552add042d716f1d168']?.symbol).toBe('USDG');
  });
});
