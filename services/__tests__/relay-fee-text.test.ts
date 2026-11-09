// DEV-621: a stablecoin fee reads 2 decimals, rounded UP so it is never under-reported.
// A plain USDC send showed "Relayer fee: ~0.021003 USDC" (Zeeshan, PR 29).
import { describe, expect, test } from 'bun:test';
import { parseUnits } from 'viem';
import { relayFeeText } from '@/services/share-rates';
import type { ShareRate } from '@/services/share-rates';

const exact = (wei: bigint) => `EXACT(${wei})`;
const fee = parseUnits('0.021003', 6);

describe('relay fee text', () => {
  test('plain USDC: 0.021003 reads ~0.03 USDC, two decimals, rounded up', () => {
    expect(relayFeeText(fee, { symbol: 'USDC', decimals: 6 }, undefined, exact)).toBe('~0.03 USDC');
  });

  test('plain USDT (BNB Chain, 18 decimals): same rule', () => {
    expect(relayFeeText(parseUnits('0.021003', 18), { symbol: 'USDT', decimals: 18 }, undefined, exact)).toBe('~0.03 USDT');
  });

  test('a fee that is exactly cents is not bumped', () => {
    expect(relayFeeText(parseUnits('0.02', 6), { symbol: 'USDC', decimals: 6 }, undefined, exact)).toBe('~0.02 USDC');
  });

  test('a share token is unchanged: converted at the rate, rounded up', () => {
    const rate: ShareRate = {
      chainId: 1, share: '0xs', underlying: '0xu', shareSymbol: 'ppUSDC', shareDecimals: 6,
      assetsPerShare: 1_050_000n, underlyingSymbol: 'USDC', underlyingDecimals: 6,
    };
    expect(relayFeeText(parseUnits('0.020003', 6), { symbol: 'ppUSDC', decimals: 6 }, rate, exact)).toBe('~0.03 USDC');
    // no rate yet: loading, never a count
    expect(relayFeeText(fee, { symbol: 'ppUSDC', decimals: 6 }, undefined, exact).startsWith('…')).toBe(true);
  });

  test('another plain token keeps its exact figure', () => {
    expect(relayFeeText(parseUnits('0.000539', 18), { symbol: 'ETH', decimals: 18 }, undefined, exact)).toBe(`EXACT(${parseUnits('0.000539', 18)})`);
  });
});
