import { describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));

const { decodeVerifiedTokens, encodeVerifiedTokens, parseLifiVerifiedTokens } = await import('@/services/lifi-token-list');

// Row shape from https://li.quest/v1/tokens?chains=56 (probed 2026-09-26).
const body = {
  tokens: {
    56: [
      { chainId: 56, address: '0x0000000000000000000000000000000000000000', symbol: 'BNB', verificationStatus: 'verified' },
      { chainId: 56, address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', verificationStatus: 'verified' },
      { chainId: 56, address: '0xcc49BcA2190Debb48e939ECCafD28CF7ca2B1570', symbol: 'BTC🚀', verificationStatus: 'flagged' },
      { chainId: 56, address: '0x0667873E07FFec6509525B4e4Cd97409e1fe9424', symbol: 'CAT' },
      { chainId: 1, address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', verificationStatus: 'verified' },
    ],
  },
};

describe('parseLifiVerifiedTokens', () => {
  test('keeps only verified rows on the chain, lowercase, native as the 0xeee sentinel', () => {
    expect([...parseLifiVerifiedTokens(body, 56)].sort()).toEqual([
      '0x55d398326f99059ff775485246999027b3197955',
      '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    ]);
  });

  test('a chain missing from the response, or a malformed body, verifies nothing', () => {
    expect(parseLifiVerifiedTokens(body, 1).size).toBe(0);
    for (const bad of [null, {}, { tokens: null }, { tokens: { 56: 'x' } }]) {
      expect(parseLifiVerifiedTokens(bad, 56).size).toBe(0);
    }
  });
});

describe('stored verified list', () => {
  const HOUR = 3_600_000;
  const verified = new Set(['0x55d398326f99059ff775485246999027b3197955', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee']);

  test('round-trips while fresh', () => {
    expect(decodeVerifiedTokens(encodeVerifiedTokens(verified, 1_000), 1_000 + HOUR, 6 * HOUR)).toEqual({ at: 1_000, verified });
  });

  test('a stale, future-dated or malformed entry reads as absent, so the grid fetches', () => {
    expect(decodeVerifiedTokens(encodeVerifiedTokens(verified, 0), 7 * HOUR, 6 * HOUR)).toBeNull();
    expect(decodeVerifiedTokens(encodeVerifiedTokens(verified, 2 * HOUR), HOUR, 6 * HOUR)).toBeNull();
    for (const bad of [null, '', '{', '{"at":1}', '{"at":1,"addresses":""}', '{"at":1,"addresses":"zz"}']) {
      expect(decodeVerifiedTokens(bad, 2, 6 * HOUR)).toBeNull();
    }
  });
});
