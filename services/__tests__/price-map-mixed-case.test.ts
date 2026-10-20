/**
 * A price is findable under every casing its callers use, and a chain's
 * balance is priced from that chain's own row.
 *
 * Two independent ways the same balance read $0.00 against a real amount
 * (QA, 2026-09-22), while the ASP was serving the figure correctly:
 *
 *   - the map was built from ONE chain's feed, the default chain, so an asset
 *     on any other chain had no row at all;
 *   - the symbol keys were the ASP's spelling and its lowercase twin, but the
 *     lookups ask for `symbol.toUpperCase()`. "cBTC" is not "CBTC", so a
 *     mixed-case symbol missed even when its row was present.
 *
 * Both are asserted against rows in the shape the ASP actually returns, and
 * across more than one symbol so a fix that only special-cases one is not
 * enough.
 */
import { describe, expect, test } from 'bun:test';
import { mergePriceMaps, priceFromMap, qualifiedPriceKey } from '@/services/price-map-merge';

/** The key set `getAllPrices` builds for one ASP row, mirrored for the merge. */
const keysFor = (symbol: string, address: string, price: number): Record<string, number> => ({
  [symbol]: price,
  [symbol.toLowerCase()]: price,
  [symbol.toUpperCase()]: price,
  [address.toLowerCase()]: price,
});

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const MAINNET = keysFor('ETH', NATIVE, 2749.63);
const CITREA = keysFor('cBTC', NATIVE, 86311.33);
const BNB = keysFor('BNB', NATIVE, 784.56);

const MIXED_CASE: readonly [string, number, Record<string, number>, number][] = [
  ['cBTC', 4114, CITREA, 86311.33],
  ['BNB', 56, BNB, 784.56],
];

describe('a mixed-case symbol is findable under the casing callers use', () => {
  for (const [symbol, chainId, prices, expected] of MIXED_CASE) {
    test(symbol, () => {
      const merged = mergePriceMaps([{ chainId, prices }], chainId);
      // The three spellings the call sites in pools-provider use between them.
      expect(merged[symbol]).toBe(expected);
      expect(merged[symbol.toUpperCase()]).toBe(expected);
      expect(merged[symbol.toLowerCase()]).toBe(expected);
    });
  }
});

describe('a balance is priced from its own chain', () => {
  const entries = [
    { chainId: 1, prices: MAINNET },
    { chainId: 4114, prices: CITREA },
    { chainId: 56, prices: BNB },
  ];

  test('a chain absent from the merge cannot be priced correctly', () => {
    // What the single-chain read produced. Every EVM chain shares one native
    // address, so the bare one holds ETH's number; `priceFromMap` does not fall
    // back to it for a row that names its chain, so a Citrea row comes back
    // empty rather than priced as ETH. By SYMBOL there is nothing either.
    const onlyMainnet = mergePriceMaps([{ chainId: 1, prices: MAINNET }], 1);
    expect(onlyMainnet['cBTC']).toBeUndefined();
    expect(onlyMainnet['CBTC']).toBeUndefined();
    expect(onlyMainnet[qualifiedPriceKey(4114, 'cBTC')]).toBeUndefined();
    expect(priceFromMap(onlyMainnet, { chainId: 4114, symbol: 'cBTC', address: NATIVE })).toBeUndefined();
  });

  const OWN_ROW: readonly [number, string, number][] = [
    [4114, 'cBTC', 86311.33],
    [56, 'BNB', 784.56],
    [1, 'ETH', 2749.63],
  ];
  for (const [chainId, symbol, expected] of OWN_ROW) {
    test(`chain ${chainId} prices ${symbol} from its own row`, () => {
      const merged = mergePriceMaps(entries, chainId);
      expect(priceFromMap(merged, { chainId, symbol, address: NATIVE })).toBe(expected);
    });
  }

  test('the shared native address does not hand one chain another chain\'s number', () => {
    // Active chain is mainnet, so the BARE sentinel key is ETH's price. A
    // Citrea row must still read its own, via the qualified key.
    const merged = mergePriceMaps(entries, 1);
    expect(merged[NATIVE.toLowerCase()]).toBe(2749.63);
    expect(merged[qualifiedPriceKey(4114, NATIVE.toLowerCase())]).toBe(86311.33);
    expect(priceFromMap(merged, { chainId: 4114, symbol: 'cBTC', address: NATIVE })).toBe(86311.33);
  });
});
