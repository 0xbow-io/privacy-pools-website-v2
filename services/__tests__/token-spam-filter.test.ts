// Fixtures are REAL rows from Alchemy's Portfolio API for
// 0x98AdDcc75931795eB66c52cA954541c18535E3c0 on eth-mainnet (probed
// 2026-08-18) — the wallet whose pay-picker was listing airdropped scams.
import { describe, expect, test } from 'bun:test';

import { filterSpamTokens, type SpamFilterToken } from '@/services/token-spam-filter';

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const REAL_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

// The chain's configured assets (config/tokens getActionableTokens shape).
const KNOWN = [
  { symbol: 'ETH', address: NATIVE },
  { symbol: 'USDC', address: REAL_USDC },
];

// LiFi's verified list for the chain (services/lifi-token-list), lowercase.
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const VERIFIED = new Set([NATIVE, REAL_USDC, WBTC]);

const t = (over: Partial<SpamFilterToken> & { symbol: string; address: string }): SpamFilterToken => ({
  name: over.symbol,
  usdValue: null,
  ...over,
});

describe('filterSpamTokens', () => {
  test('keeps priced holdings and the chain’s configured assets', () => {
    const kept = filterSpamTokens(
      [
        t({ symbol: 'ETH', name: 'Ether', address: NATIVE, usdValue: 91.2 }),
        t({ symbol: 'WBTC', name: 'Wrapped Bitcoin', address: WBTC, usdValue: 4200 }),
        t({ symbol: 'USDC', name: 'USD Coin', address: REAL_USDC, usdValue: 0 }),
      ],
      KNOWN,
      VERIFIED,
    );
    expect(kept.map((k) => k.symbol)).toEqual(['ETH', 'WBTC', 'USDC']);
  });

  test('drops the unpriced airdrops that crowded the picker', () => {
    const junk = [
      t({ symbol: 'DOG', name: 'Royal Dog', address: '0x00e2b6d170740c15bf9fb01d0b6e77c0d4510e32' }),
      t({ symbol: 'YES', name: 'YES', address: '0x7f3ba3f18f1378fbd8efa0a20bfe7016e2efd266' }),
      t({ symbol: 'SUPERDOG', name: 'SUPERDOG', address: '0x695e449525d42055d368f84e97912032c7410a46' }),
      t({ symbol: 'YFTE', name: 'YFTether', address: '0x94f31ac896c9823d81cf9c2c93feceed4923218f' }),
      t({ symbol: 'YRISE', name: 'yRise Finance', address: '0x6051c1354ccc51b4d561e43b02735deae64768b8' }),
      t({ symbol: 'TRUNK', name: 'Donald Trunk', address: '0x7f97f3d313d336714a5ed43ed636d5507fef6165' }),
      t({ symbol: 'GUS', name: 'Cheesy Gus', address: '0x541b88aa9617d0bf064d3f2f2ba2726365870153' }),
      t({ symbol: 'KEB', name: 'Shibo Kibo', address: '0x111bb5c4157f3ec5f1967e57025ea84a924efe07' }),
    ];
    expect(filterSpamTokens(junk, KNOWN, VERIFIED)).toEqual([]);
  });

  test('drops impersonators of a configured asset even when priced', () => {
    const kept = filterSpamTokens(
      [
        // Two fake "USDC" contracts this wallet actually holds.
        t({ symbol: 'USDC', name: 'USDC', address: '0x5bb52e49e0c4045fdace6bcda8e16340ec5208f9' }),
        t({ symbol: 'USDC', name: 'USDC', address: '0x7626905818409a2d044a57730719bbdf5f2dcd29', usdValue: 999 }),
        t({ symbol: 'USDC', name: 'USD Coin', address: REAL_USDC, usdValue: 12 }),
      ],
      KNOWN,
      VERIFIED,
    );
    expect(kept.map((k) => k.address)).toEqual([REAL_USDC]);
  });

  test('drops homoglyph impersonation (non-ASCII symbol/name)', () => {
    // Real row: symbol "υՏƊⅭ", name "υƧƊⅭ" — Greek/Cherokee lookalikes.
    const kept = filterSpamTokens(
      [t({ symbol: 'υՏƊⅭ', name: 'υƧƊⅭ', address: '0x1d946a8eaadd7210bc91d2e9be841dd7867d18e3', usdValue: 5 })],
      KNOWN,
      VERIFIED,
    );
    expect(kept).toEqual([]);
  });

  test('drops link/claim payloads in the symbol or name, priced or not', () => {
    const kept = filterSpamTokens(
      [
        t({ symbol: 'CLAIM', name: 'Visit claim-rewards.xyz to claim', address: '0xaa1', usdValue: 7 }),
        t({ symbol: 'https://x.io', name: 'Airdrop', address: '0xaa2' }),
        t({ symbol: 'VERYLONGSYMBOLINDEED', name: 'x', address: '0xaa3', usdValue: 3 }),
      ],
      KNOWN,
      VERIFIED,
    );
    expect(kept).toEqual([]);
  });

  test('a configured asset is never dropped by the metadata rules', () => {
    // Citrea's native cBTC: mixed case, and its "name" is whatever config says.
    const known = [{ symbol: 'cBTC', address: NATIVE }];
    const kept = filterSpamTokens(
      [t({ symbol: 'cBTC', name: 'Citrea Bitcoin', address: NATIVE })],
      known,
      VERIFIED,
    );
    expect(kept.map((k) => k.symbol)).toEqual(['cBTC']);
  });

  test('address comparison is case-insensitive on both sides', () => {
    const kept = filterSpamTokens(
      [t({ symbol: 'USDC', name: 'USD Coin', address: REAL_USDC.toUpperCase() })],
      KNOWN,
      VERIFIED,
    );
    expect(kept).toHaveLength(1);
  });

  test('an empty symbol is dropped rather than rendered as a blank row', () => {
    expect(filterSpamTokens([t({ symbol: '', name: 'nothing', address: '0xbb1', usdValue: 4 })], KNOWN, VERIFIED)).toEqual([]);
  });

  test('a priced token LiFi does not verify is dropped', () => {
    // Scams seed a thin pool to get priced; LiFi flags or omits them.
    const kept = filterSpamTokens(
      [t({ symbol: 'PEPEShib', name: 'PEPEShib', address: '0x00000735675868c85f45160e38ee02d4c8ea546d', usdValue: 50 })],
      KNOWN,
      VERIFIED,
    );
    expect(kept).toEqual([]);
  });

  test('a verified token Alchemy could not price is dropped', () => {
    expect(filterSpamTokens([t({ symbol: 'WBTC', name: 'Wrapped Bitcoin', address: WBTC })], KNOWN, VERIFIED)).toEqual([]);
  });

  test('without the LiFi list only configured assets survive', () => {
    const kept = filterSpamTokens(
      [
        t({ symbol: 'WBTC', name: 'Wrapped Bitcoin', address: WBTC, usdValue: 4200 }),
        t({ symbol: 'USDC', name: 'USD Coin', address: REAL_USDC, usdValue: 12 }),
      ],
      KNOWN,
      null,
    );
    expect(kept.map((k) => k.symbol)).toEqual(['USDC']);
  });
});
