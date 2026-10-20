import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { EMPTY_PRICE_MAP, mergePriceMaps, priceFromMap, qualifiedPriceKey } from '@/services/price-map-merge';

describe('mergePriceMaps', () => {
  const eth = { chainId: 1, prices: { USDC: 1.0, WETH: 2500, '0xaaa': 1.0 } };
  const op = { chainId: 10, prices: { USDC: 0.99, OP: 1.5 } };

  test('carries every chain\'s tokens', () => {
    expect(mergePriceMaps([eth, op])).toMatchObject({ WETH: 2500, OP: 1.5, '0xaaa': 1.0 });
  });

  // Symbols and bare addresses are not chain-qualified, so two chains can
  // disagree about "USDC". The chain the screen is on is the one it means.
  test('the active chain wins a collision, whatever order the feeds are in', () => {
    expect(mergePriceMaps([eth, op], 10).USDC).toBe(0.99);
    expect(mergePriceMaps([op, eth], 10).USDC).toBe(0.99);
    expect(mergePriceMaps([eth, op], 1).USDC).toBe(1.0);
    expect(mergePriceMaps([op, eth], 1).USDC).toBe(1.0);
  });

  test('a feed that has not answered contributes nothing', () => {
    const merged = mergePriceMaps([{ chainId: 1, prices: null }, op]);
    expect(merged).toEqual({ USDC: 0.99, OP: 1.5, '10:USDC': 0.99, '10:OP': 1.5 });
    // Nothing is attributed to the silent chain, under either key shape.
    expect(merged['1:USDC']).toBeUndefined();
  });

  // A zero is not a price. Letting one through renders "$0.00" against a real
  // balance, which reads as "your money is gone".
  test('drops zero, negative and non-finite prices rather than showing them', () => {
    const merged = mergePriceMaps([{ chainId: 1, prices: { A: 0, B: -1, C: NaN, D: Infinity, E: 2 } }]);
    expect(merged).toEqual({ E: 2, '1:E': 2 });
  });

  // The sharp case, and the reason the qualified key exists: EVERY EVM chain in
  // this app names its native asset with the same 0xEeee… sentinel. Flattened
  // by address alone, a Citrea cBTC row reads mainnet ETH's number — off by
  // more than an order of magnitude, in the direction that flatters the
  // balance. Two screens carried a `sameChain` guard apologising for this.
  test('two chains sharing the native sentinel each keep their own price', () => {
    const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const mainnet = { chainId: 1, prices: { ETH: 2500, [NATIVE]: 2500 } };
    const citrea = { chainId: 4114, prices: { CBTC: 61000, [NATIVE]: 61000 } };
    const merged = mergePriceMaps([mainnet, citrea], 1);
    // The bare key still answers for the active chain, as single-chain screens expect.
    expect(merged[NATIVE]).toBe(2500);
    // But a row that names its chain gets its chain's figure, either way round.
    expect(priceFromMap(merged, { chainId: 4114, address: NATIVE, symbol: 'CBTC' })).toBe(61000);
    expect(priceFromMap(merged, { chainId: 1, address: NATIVE, symbol: 'ETH' })).toBe(2500);
    expect(merged[qualifiedPriceKey(4114, NATIVE)]).toBe(61000);
  });

  // The bare sentinel holds the ACTIVE chain's native price, so it can never
  // stand in for another chain's: a 0.02 BNB deposit read $54 (ETH's price)
  // while Ethereum was active and $16 on BNB Chain.
  test('a native row whose chain has no price never borrows another chain\'s native price', () => {
    const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const mainnet = { chainId: 1, prices: { ETH: 2700, [NATIVE]: 2700 } };
    const bsc = { chainId: 56, prices: { BNB: 800, [NATIVE]: 800 } };
    const ethActive = mergePriceMaps([mainnet, bsc], 1);
    expect(priceFromMap(ethActive, { chainId: 56, address: NATIVE, symbol: 'BNB' })).toBe(800);
    // BNB Chain's feed has not answered: the symbol may still come from another
    // feed, but the bare sentinel (ETH's here) must not.
    const bscSilent = mergePriceMaps([mainnet, { chainId: 56, prices: null }], 1);
    expect(priceFromMap(bscSilent, { chainId: 56, address: NATIVE, symbol: 'BNB' })).toBeUndefined();
    expect(priceFromMap({ ...bscSilent, BNB: 790 }, { chainId: 56, address: NATIVE, symbol: 'BNB' })).toBe(790);
    // A caller with no chain still gets the bare key, as before.
    expect(priceFromMap(bscSilent, { address: NATIVE })).toBe(2700);
  });

  // A chain with no figure of its own is better served by the bare key than by
  // nothing: the old guard answered 0, which renders as "$0.00".
  test('a row falls back to the bare key only when its own chain is silent', () => {
    const merged = mergePriceMaps([eth, op], 1);
    expect(priceFromMap(merged, { chainId: 10, address: '0xaaa', symbol: 'USDC' })).toBe(0.99);
    // 0xaaa exists only on chain 1, so a chain-10 row falls through to it.
    expect(priceFromMap(merged, { chainId: 10, address: '0xaaa', symbol: 'NOPE' })).toBe(1.0);
    expect(priceFromMap(merged, { chainId: 10, address: '0xzzz', symbol: 'NOPE' })).toBeUndefined();
  });

  // Zero is the ASP's testnet reading for "unknown".
  test('priceFromMap treats a zero as unknown and keeps looking', () => {
    const merged = mergePriceMaps([{ chainId: 1, prices: { USDC: 2 } }]);
    expect(priceFromMap({ ...merged, '1:0xaaa': 0 }, { chainId: 1, address: '0xAAA', symbol: 'USDC' })).toBe(2);
  });

  // This feeds a useSyncExternalStore snapshot: a fresh object for "nothing
  // yet" would re-render forever.
  test('returns one stable empty map when there is nothing to merge', () => {
    expect(mergePriceMaps([])).toBe(EMPTY_PRICE_MAP);
    expect(mergePriceMaps([{ chainId: 1, prices: null }])).toBe(EMPTY_PRICE_MAP);
  });
});

// The ratchet. The AST guard in no-activity-correlated-polling only inspects
// useQuery options and effect bodies, so it cannot see a bare price call in a
// component — which is exactly how these three shipped.
describe('no component may ask for prices', () => {
  const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
  const SCANNED = ['components', 'app'];

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path, out);
      else if (/\.tsx?$/.test(entry)) out.push(path);
    }
    return out;
  }

  /** Calls, not mentions: the comments explaining this rule name the functions. */
  const withoutComments = (source: string) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // `getPrice` joined the list on 2026-09-18. It was the hole this ratchet
  // left: it hits the SAME /global/public/token-prices endpoint, so a
  // `useQuery(['tokenPrice', symbol])` in a component is exactly the request
  // the rule exists to stop. Three of them shipped, and the e2e privacy gate
  // caught the worst one in production — opening the Withdraw tab flipped a
  // query's `enabled` and sent a token-prices request right then, announcing
  // "this client is preparing a withdrawal" by its timing alone.
  test('getPrice, getAllPrices and getTokenPrices are not called under components/ or app/', () => {
    const offenders: string[] = [];
    for (const dir of SCANNED) {
      for (const file of walk(join(ROOT, dir))) {
        const code = withoutComments(readFileSync(file, 'utf8'));
        if (/\b(getPrice|getAllPrices|getTokenPrices)\s*\(/.test(code)) {
          offenders.push(`${file.slice(ROOT.length + 1)}`);
        }
      }
    }
    // A chain-scoped call is not safe either: the module cache TTL and the grid
    // period are both five minutes, so an off-grid bootstrap leaves a window
    // where mount, window focus or a post-transaction invalidation puts the
    // request on the wire itself (codex, 2026-09-15). services/public-feeds.ts
    // is the only sanctioned caller and is not under these directories.
    //
    // The list is empty again. deposit-modal-provider.tsx sat here briefly:
    // moving it to the grid first time BLOCKED PAYMENTS, because its
    // "still loading" flag was inferred from an empty price map and the dev ASP
    // publishes a valid empty one. It is back on the grid now that
    // usePriceFeedsSettled() reports whether the grid has ANSWERED, which is
    // what useQuery's isPending actually meant.
    expect(offenders).toEqual([]);
  });
});
