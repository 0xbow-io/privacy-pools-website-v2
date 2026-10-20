import { describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));

const { markSuspiciousTokens, parseAlchemyTokenRows } = await import('@/services/wallet-tokens');
const { getActionableTokens } = await import('@/config/tokens');

const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const LINK_BSC = '0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd';
const PEPESHIB_BSC = '0x00000735675868c85f45160e38ee02d4c8ea546d';
const LINK_ETH = '0x514910771af9ca656af840dff83e8264ecf986ca';

const networks = new Map([['eth-mainnet', 1], ['bnb-mainnet', 56]]);

// Row shape from Alchemy's assets/tokens/by-address with two networks.
const rows = [
  { network: 'bnb-mainnet', tokenAddress: null, tokenBalance: '0x0de0b6b3a7640000', tokenPrices: [{ currency: 'usd', value: '700' }] },
  {
    network: 'bnb-mainnet', tokenAddress: '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD', tokenBalance: '0x8ac7230489e80000',
    tokenMetadata: { symbol: 'LINK', name: 'ChainLink Token', decimals: 18, logo: 'https://x.test/link.png' },
    tokenPrices: [{ currency: 'usd', value: '14' }],
  },
  {
    network: 'bnb-mainnet', tokenAddress: PEPESHIB_BSC, tokenBalance: '0x01',
    tokenMetadata: { symbol: 'PEPEShib', name: 'PEPEShib', decimals: 0 }, tokenPrices: [{ currency: 'usd', value: '999' }],
  },
  { network: 'bnb-mainnet', tokenAddress: '0xabc', tokenBalance: '0x0', tokenMetadata: { symbol: 'ZERO', decimals: 18 } },
  {
    network: 'eth-mainnet', tokenAddress: LINK_ETH, tokenBalance: '0x0de0b6b3a7640000',
    tokenMetadata: { symbol: 'LINK', name: 'ChainLink Token', decimals: 18 }, tokenPrices: [{ currency: 'usd', value: '14' }],
  },
  { network: 'opt-mainnet', tokenAddress: '0xdef', tokenBalance: '0x1', tokenMetadata: { symbol: 'X', decimals: 18 } },
];

describe('parseAlchemyTokenRows', () => {
  test('splits one multi-network response by chain and names each native coin after its chain', () => {
    const byChain = parseAlchemyTokenRows(rows, networks);
    expect(Object.keys(byChain).map(Number).sort((a, b) => a - b)).toEqual([1, 56]);
    expect(byChain[56].map((t) => t.symbol)).toEqual(['PEPEShib', 'BNB', 'LINK']);
    expect(byChain[56][1].address).toBe(NATIVE);
    expect(byChain[56][2].address).toBe(LINK_BSC);
    expect(byChain[1].map((t) => t.symbol)).toEqual(['LINK']);
  });
});

describe('markSuspiciousTokens', () => {
  const bsc = () => parseAlchemyTokenRows(rows, networks)[56];

  test('a priced token LiFi does not verify goes behind the reveal, verified ones stay', () => {
    const marked = markSuspiciousTokens(bsc(), 56, new Set([NATIVE, LINK_BSC]));
    expect(marked.map((t) => [t.symbol, !!t.suspicious])).toEqual([['BNB', false], ['LINK', false], ['PEPEShib', true]]);
  });

  test('until the LiFi list arrives only the chain’s configured assets are unmarked', () => {
    const configured = new Set(getActionableTokens(56).map((t) => t.address.toLowerCase()));
    for (const token of markSuspiciousTokens(bsc(), 56, null)) {
      expect(!!token.suspicious).toBe(!configured.has(token.address));
    }
  });
});
