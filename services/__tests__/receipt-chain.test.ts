import { describe, expect, test } from 'bun:test';

import { ENVIRONMENTS } from '@/config/environments';
import { STAGING_CHAINS, STAGING_MAINNET_ONLY_CHAIN_IDS } from '@/config/staging-deployments';
import { buildEnvironmentChains, environmentChainIds, receiptAutoSwitchKey, receiptSwitchTarget, requestChainRefusal, resolveReceiptChain } from '@/services/receipt-chain';

// Built from the SHIPPED config. Only the base chain's name comes from the
// static chain registry, which bun cannot import; its id does not.
const TABLES = buildEnvironmentChains(
  Object.values(ENVIRONMENTS),
  { chains: STAGING_CHAINS, mainnetOnlyChainIds: STAGING_MAINNET_ONLY_CHAIN_IDS, mainnetQuery: 'staging-mainnet' },
  (id) => (id === 11155111 ? 'Sepolia' : undefined),
);

describe('receipt chain naming (DEV-457)', () => {
  test('staging serves Sepolia as its base chain and prod does not', () => {
    expect(environmentChainIds(ENVIRONMENTS.staging)).toContain(11155111);
    expect(environmentChainIds(ENVIRONMENTS.prod)).not.toContain(11155111);
  });

  test('a Sepolia receipt on Prod names Sepolia and offers plain Testnet', () => {
    expect(resolveReceiptChain(11155111, undefined, 'prod', TABLES)).toEqual({
      name: 'Sepolia',
      supported: true,
      otherEnvironment: { id: 'staging', label: 'Testnet', query: 'staging' },
    });
  });

  test('a staging-mainnet-only chain switches with ?env=staging-mainnet, not plain staging', () => {
    // A fixed staging list: OP/Base can be hidden per build (OPTIMISM_STAGING_HIDDEN,
    // BASE_STAGING_HIDDEN), and the mapping must hold whatever the flags say.
    const tables = buildEnvironmentChains(
      Object.values(ENVIRONMENTS),
      { chains: [{ chainId: 10, displayName: 'OP Mainnet' }], mainnetOnlyChainIds: new Set([10]), mainnetQuery: 'staging-mainnet' },
      () => undefined,
    );
    expect(resolveReceiptChain(10, undefined, 'prod', tables).otherEnvironment?.query).toBe('staging-mainnet');
  });

  test('a chain this environment serves keeps its name, an unknown one is unsupported', () => {
    expect(resolveReceiptChain(1, 'Ethereum', 'prod', TABLES)).toEqual({ name: 'Ethereum', supported: true });
    expect(resolveReceiptChain(999, undefined, 'prod', TABLES)).toEqual({ name: 'Chain 999', supported: false });
  });
});

describe('a payment request on another environment\'s chain (DEV-485)', () => {
  const tables = buildEnvironmentChains(
    Object.values(ENVIRONMENTS),
    { chains: [{ chainId: 10, displayName: 'OP Mainnet' }], mainnetOnlyChainIds: new Set([10]), mainnetQuery: 'staging-mainnet' },
    () => undefined,
  );

  test('names the chain and the environment that pays it, never a raw chain id', () => {
    const text = requestChainRefusal(resolveReceiptChain(10, undefined, 'prod', tables));
    expect(text).toBe('This request is for OP Mainnet, on Staging. Switch to Staging (staging-mainnet) to pay it.');
    expect(text).not.toContain('chainId');
  });

  test('a chain no environment serves says so', () => {
    expect(requestChainRefusal(resolveReceiptChain(999, undefined, 'prod', tables))).toContain('which this app does not support');
  });
});

describe('switching to a link chain by itself', () => {
  const selectable = (id: number) => id === 1 || id === 4114;
  const here = { name: 'Ethereum', supported: true } as const;

  test('a link on a chain this app offers switches to it', () => {
    expect(receiptSwitchTarget({ linkChainId: 1, sessionChainId: 4114, chain: here, selectable })).toBe(1);
  });

  test('nothing to do when the app is already there, or the link names no chain', () => {
    expect(receiptSwitchTarget({ linkChainId: 1, sessionChainId: 1, chain: here, selectable })).toBeNull();
    expect(receiptSwitchTarget({ linkChainId: undefined, sessionChainId: 1, chain: here, selectable })).toBeNull();
  });

  test('a chain only another environment serves keeps the explicit Environment button', () => {
    const elsewhere = resolveReceiptChain(11155111, undefined, 'prod', TABLES);
    expect(elsewhere.otherEnvironment).toBeDefined();
    expect(receiptSwitchTarget({ linkChainId: 11155111, sessionChainId: 1, chain: elsewhere, selectable: () => true })).toBeNull();
  });

  test('never selects a chain no picker here offers', () => {
    expect(receiptSwitchTarget({ linkChainId: 10, sessionChainId: 1, chain: { name: 'OP', supported: true }, selectable })).toBeNull();
    expect(receiptSwitchTarget({ linkChainId: 999, sessionChainId: 1, chain: { name: 'Chain 999', supported: false }, selectable: () => true })).toBeNull();
  });

  test('one automatic try per chain and connection state, none while the wallet is connecting', () => {
    expect(receiptAutoSwitchKey(null, 'connected')).toBeNull();
    expect(receiptAutoSwitchKey(1, 'pending')).toBeNull();
    expect(receiptAutoSwitchKey(1, 'disconnected')).not.toBe(receiptAutoSwitchKey(1, 'connected'));
    expect(receiptAutoSwitchKey(1, 'connected')).toBe(receiptAutoSwitchKey(1, 'connected'));
  });
});
