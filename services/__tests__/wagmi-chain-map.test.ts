// The wagmi chain-map invariant: every chain the app can register must have
// a viem Chain object, or wagmi silently drops it and the selector offers a
// chain no one can switch to (the OP-shipped-broken bug in 596eba2 — the
// click was a no-op because switchChainAsync threw ChainNotConfiguredError
// into a silent catch).
//
// STAGING_CHAINS is importable unconditionally (the env flags gate its USE,
// not its definition), so this covers every staging id plus the two build
// bases without needing chains.ts (which is not bun-loadable).

import { describe, expect, test } from 'bun:test';
import { VIEM_CHAIN_BY_ID } from '../../config/wagmi-chain-map';
import { STAGING_CHAINS } from '../../config/staging-deployments';
import { ALL_PROD_CHAINS } from '../../config/prod-deployments';

describe('VIEM_CHAIN_BY_ID', () => {
  test('covers every staging chain id', () => {
    for (const d of STAGING_CHAINS) {
      expect(VIEM_CHAIN_BY_ID[d.chainId]?.id).toBe(d.chainId);
    }
  });

  test('covers both build-base EVM chains (Sepolia test, mainnet prod)', () => {
    expect(VIEM_CHAIN_BY_ID[11155111]?.id).toBe(11155111);
    expect(VIEM_CHAIN_BY_ID[1]?.id).toBe(1);
  });

  // Explicit per-chain pins, ENV-INDEPENDENT: the STAGING_CHAINS loop above
  // goes vacuous for a chain its hide flag removes (running the suite with
  // EXPO_PUBLIC_STAGING_OPTIMISM=false would drop chain 10 from the loop and
  // stop guarding its map entry). Codex review of 1454f30 confirmed that
  // hole by running exactly that env.
  test('pins every known staging id explicitly, regardless of hide flags', () => {
    expect(VIEM_CHAIN_BY_ID[10]?.id).toBe(10); // Optimism
    expect(VIEM_CHAIN_BY_ID[4114]?.id).toBe(4114); // Citrea
    expect(VIEM_CHAIN_BY_ID[8453]?.id).toBe(8453); // Base
  });

  // Prod chains, pending ones included: opting a pending chain in through the
  // env must never produce a listed-but-unswitchable chain.
  test('covers every prod deployment, served or pending', () => {
    for (const d of ALL_PROD_CHAINS) {
      expect(VIEM_CHAIN_BY_ID[d.chainId]?.id).toBe(d.chainId);
    }
    expect(VIEM_CHAIN_BY_ID[42161]?.id).toBe(42161); // Arbitrum One
    expect(VIEM_CHAIN_BY_ID[4663]?.id).toBe(4663); // Robinhood Chain
  });
});
