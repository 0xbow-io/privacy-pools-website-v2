/**
 * Guards the Sui network seam (config/env.ts + config/sui.ts).
 *
 * Two invariants that are easy to regress and expensive to get wrong:
 *  1. Only an explicit "mainnet" selects mainnet, and selecting it fails CLOSED
 *     (throws at import) while mainnet has no deployed contracts and several
 *     paths still hardcode the testnet chain id.
 *  2. The legacy, network-agnostic EXPO_PUBLIC_SUI_RPC_URL is TESTNET-scoped. If
 *     it ever fed mainnet again, a deployment that kept it and merely flipped the
 *     network flag would read balances from testnet while dapp-kit asked the
 *     wallet to sign for `sui:mainnet`.
 *
 * These modules read process.env at import time, so every case resets the module
 * registry and re-imports.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL = process.env.EXPO_PUBLIC_SUI_NETWORK;

function setNetwork(value: string | undefined) {
  if (value === undefined) delete process.env.EXPO_PUBLIC_SUI_NETWORK;
  else process.env.EXPO_PUBLIC_SUI_NETWORK = value;
  vi.resetModules();
}

beforeEach(() => vi.resetModules());
afterEach(() => setNetwork(ORIGINAL));

describe('EXPO_PUBLIC_SUI_NETWORK', () => {
  it('defaults to testnet when unset, and imports cleanly', async () => {
    setNetwork(undefined);
    const sui = await import('@/config/sui');
    expect(sui.ACTIVE_SUI_NETWORK).toBe('testnet');
    expect(sui.ACTIVE_SUI_RPC_URL).toBe(sui.SUI_NETWORKS.testnet.url);
  });

  it('fails closed on an explicit mainnet, rather than shipping a half-wired build', async () => {
    setNetwork('mainnet');
    await expect(import('@/config/sui')).rejects.toThrow(/not supported yet/i);
  });

  it('is case-insensitive, so MAINNET also fails closed', async () => {
    setNetwork('MAINNET');
    await expect(import('@/config/sui')).rejects.toThrow(/not supported yet/i);
  });

  // A typo must never silently select mainnet; falling back to testnet is the
  // safe direction.
  it.each(['Mainnett', 'main', '', '   ', 'testnet'])(
    'resolves %o to testnet',
    async (value) => {
      setNetwork(value);
      const sui = await import('@/config/sui');
      expect(sui.ACTIVE_SUI_NETWORK).toBe('testnet');
    },
  );
});

describe('legacy EXPO_PUBLIC_SUI_RPC_URL scoping', () => {
  it('overrides the testnet URL but never the mainnet URL', async () => {
    // setup.ts sets EXPO_PUBLIC_SUI_RPC_URL to a testnet node.
    const legacy = process.env.EXPO_PUBLIC_SUI_RPC_URL;
    expect(legacy).toBeTruthy();

    setNetwork(undefined);
    const env = await import('@/config/env');
    expect(env.SUI_TESTNET_RPC_URL).toBe(legacy);
    expect(env.SUI_MAINNET_RPC_URL).not.toBe(legacy);
  });

  it('lets the per-network override win over the legacy one', async () => {
    const previous = process.env.EXPO_PUBLIC_SUI_TESTNET_RPC_URL;
    process.env.EXPO_PUBLIC_SUI_TESTNET_RPC_URL = 'https://testnet.override.invalid';
    setNetwork(undefined);
    try {
      const env = await import('@/config/env');
      expect(env.SUI_TESTNET_RPC_URL).toBe('https://testnet.override.invalid');
    } finally {
      if (previous === undefined) delete process.env.EXPO_PUBLIC_SUI_TESTNET_RPC_URL;
      else process.env.EXPO_PUBLIC_SUI_TESTNET_RPC_URL = previous;
    }
  });
});
