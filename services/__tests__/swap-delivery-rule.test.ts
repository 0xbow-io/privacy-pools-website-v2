/**
 * What the "Receive as" picker offers.
 *
 * The case that drove this: on prod mainnet the configured output table is
 * ETH plus three yield shares, and shares cannot be delivered, so the picker
 * offered exactly one asset. Meanwhile the registry holds plain USDC and USDT,
 * which LiFi pays out without difficulty and which is the first thing anyone
 * asks for (Mike, 2026-09-22: "USDC isn't available as a sending asset").
 */
import { describe, expect, test } from 'bun:test';

import { mergeDeliveryTokens } from '../swap-delivery-rule';

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/** Prod mainnet in miniature: one coin, one share, two superseded stables. */
const MAINNET_REGISTRY = {
  [NATIVE.toLowerCase()]: { symbol: 'ETH', decimals: 18 },
  '0xc246afb23482ff9596e9cee5f1f678efe0eb1ad6': { symbol: 'ppUSDC', decimals: 18, yieldShare: { underlying: 'USDC' } },
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': { symbol: 'USDC', decimals: 6 },
  '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 },
};

const CONFIGURED = [
  { symbol: 'ETH', address: NATIVE, decimals: 18, isNative: true },
  { symbol: 'ppUSDC', address: '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6', decimals: 18, isNative: false },
];

describe('mergeDeliveryTokens', () => {
  const result = mergeDeliveryTokens(CONFIGURED, MAINNET_REGISTRY, NATIVE);
  const symbols = result.map((t) => t.symbol);

  test('a yield share is never deliverable, from either source', () => {
    // The 2026-09-04 liquidity constraint: LiFi has to buy and pay out this
    // exact token, and nothing sells a share.
    expect(symbols).not.toContain('ppUSDC');
  });

  test('the plain assets the registry knows are offered', () => {
    // This is the whole fix. Before it, this list was ['ETH'].
    expect(symbols).toContain('USDC');
    expect(symbols).toContain('USDT');
    expect(symbols).toContain('ETH');
  });

  test('a superseded pool is still deliverable', () => {
    // `superseded` says nobody may DEPOSIT into it, not that the coin cannot
    // be handed to an address.
    const usdc = result.find((t) => t.symbol === 'USDC');
    expect(usdc?.decimals).toBe(6);
  });

  test('the configured entries keep their order and come first', () => {
    // The first list is curated, the second is however the registry is keyed.
    expect(symbols[0]).toBe('ETH');
  });

  test('a token in both lists appears once, with the configured spelling', () => {
    // The registry keys on a lowercased address; the tables spell it mixed.
    // Matching by anything but a lowercased address would duplicate the row.
    expect(result.filter((t) => t.address.toLowerCase() === NATIVE.toLowerCase())).toHaveLength(1);
    expect(result.find((t) => t.address.toLowerCase() === NATIVE.toLowerCase())?.address).toBe(NATIVE);
  });

  test('the native asset is flagged whichever list it came from', () => {
    const fromRegistryOnly = mergeDeliveryTokens([], MAINNET_REGISTRY, NATIVE);
    expect(fromRegistryOnly.find((t) => t.symbol === 'ETH')?.isNative).toBe(true);
  });

  test('an empty registry changes nothing', () => {
    expect(mergeDeliveryTokens(CONFIGURED, {}, NATIVE).map((t) => t.symbol)).toEqual(['ETH', 'ppUSDC']);
  });
});
