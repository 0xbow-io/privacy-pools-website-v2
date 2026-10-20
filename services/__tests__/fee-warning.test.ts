import { describe, expect, test } from 'bun:test';
import { FEE_WARNING_CONFIG, type FeeWarningConfig } from '../../config/fee-warnings';
import {
  buildFeeBreakdown,
  feePercent,
  feeWarningLevel,
  feeWarningTier,
  formatFeePercent,
  formatGweiShort,
  gasCostUsd,
  quoteGas,
  relayedSpendBreakdown,
  splitRelayerFee,
  swapLossUsd,
  tokenUsd,
} from '../fee-warning';

const noFloor: FeeWarningConfig = { ...FEE_WARNING_CONFIG, minFeeUsd: 0 };

describe('tier table', () => {
  test('bands are ascending, start at zero, and the severe threshold is never below the first', () => {
    const tiers = FEE_WARNING_CONFIG.tiers;
    expect(tiers[0]!.minAmountUsd).toBe(0);
    for (let i = 0; i < tiers.length; i += 1) {
      expect(tiers[i]!.secondPct).toBeGreaterThan(tiers[i]!.firstPct);
      if (i > 0) {
        expect(tiers[i]!.minAmountUsd).toBeGreaterThan(tiers[i - 1]!.minAmountUsd);
        expect(tiers[i]!.firstPct).toBeLessThanOrEqual(tiers[i - 1]!.firstPct);
        expect(tiers[i]!.secondPct).toBeLessThanOrEqual(tiers[i - 1]!.secondPct);
      }
    }
  });

  test('the lower bound of each band is inclusive', () => {
    expect(feeWarningTier(49.99)!.minAmountUsd).toBe(0);
    expect(feeWarningTier(50)!.minAmountUsd).toBe(50);
    expect(feeWarningTier(150)!.minAmountUsd).toBe(150);
    expect(feeWarningTier(500)!.minAmountUsd).toBe(500);
    expect(feeWarningTier(1_000)!.minAmountUsd).toBe(1_000);
    expect(feeWarningTier(10_000)!.minAmountUsd).toBe(10_000);
    expect(feeWarningTier(1_000_000)!.minAmountUsd).toBe(10_000);
  });
});

describe('each band at, just below and just above both thresholds', () => {
  const amounts = [
    { amount: 40, first: 20, second: 50 },
    { amount: 100, first: 15, second: 30 },
    { amount: 300, first: 10, second: 20 },
    { amount: 800, first: 5, second: 10 },
    { amount: 5_000, first: 2.5, second: 5 },
    { amount: 50_000, first: 1, second: 5 },
  ];
  for (const { amount, first, second } of amounts) {
    const feeAt = (pct: number) => (amount * pct) / 100;
    test(`$${amount}: ${first}% / ${second}%`, () => {
      expect(feeWarningLevel(amount, feeAt(first - 0.01), noFloor)).toBe('none');
      expect(feeWarningLevel(amount, feeAt(first), noFloor)).toBe('first');
      expect(feeWarningLevel(amount, feeAt(first + 0.01), noFloor)).toBe('first');
      expect(feeWarningLevel(amount, feeAt(second - 0.01), noFloor)).toBe('first');
      expect(feeWarningLevel(amount, feeAt(second), noFloor)).toBe('second');
      expect(feeWarningLevel(amount, feeAt(second + 0.01), noFloor)).toBe('second');
    });
  }
});

describe('band edges', () => {
  test('$49.99 uses the under-$50 band, $50.00 the next one', () => {
    expect(feeWarningLevel(49.99, 8)).toBe('none');
    expect(feeWarningLevel(50, 8)).toBe('first');
  });

  test('exact thresholds survive floating point', () => {
    expect(feeWarningLevel(50, 7.5)).toBe('first');
    expect(feeWarningLevel(0.1 + 0.2, 0.06, noFloor)).toBe('first');
  });
});

test('a ~$26.5 cross-chain swap paying $8 to $10.5 shows the first warning only', () => {
  expect(feeWarningLevel(26.5, 8)).toBe('first');
  expect(feeWarningLevel(26.5, 10.5)).toBe('first');
});

test('a fee under the floor never warns', () => {
  expect(feeWarningLevel(2, 0.45)).toBe('none');
  expect(feeWarningLevel(2, 1)).toBe('second');
});

test('an amount or fee that cannot be priced is no warning, not a false one', () => {
  expect(feeWarningLevel(null, 5)).toBe('none');
  expect(feeWarningLevel(10, null)).toBe('none');
  expect(feeWarningLevel(0, 5)).toBe('none');
  expect(feeWarningLevel(Number.NaN, 5)).toBe('none');
  expect(feeWarningLevel(10, Number.POSITIVE_INFINITY)).toBe('none');
  expect(feePercent(10, -1)).toBeNull();
});

describe('breakdown', () => {
  test('a relayed spend splits the relayer fee into the gas it re-bills and its margin', () => {
    // $26.50 of USDC on Ethereum at 12 gwei, ETH at $2500: 850k gas is $25.50.
    const b = relayedSpendBreakdown({
      chainId: 1,
      amountWei: 26_500_000n,
      feeWei: 25_600_000n,
      decimals: 6,
      tokenUsd: 1,
      gasUnits: 850_000n,
      gasPriceWei: 12_000_000_000n,
      nativeUsd: 2500,
    })!;
    expect(b.networkUsd).toBeCloseTo(25.5, 6);
    expect(b.serviceUsd).toBeCloseTo(0.1, 6);
    expect(b.totalUsd).toBeCloseTo(25.6, 6);
    expect(b.level).toBe('second');
    expect(b.suggestWaiting).toBe(true);
    expect(b.gas).toEqual([{ chainId: 1, gwei: '12' }]);
  });

  test('gas the relayer reports above its own fee never shows a negative margin', () => {
    expect(splitRelayerFee(1, 3)).toEqual({ networkUsd: 1, serviceUsd: 0 });
    expect(splitRelayerFee(1, null)).toEqual({ networkUsd: 1, serviceUsd: 0 });
  });

  test('waiting is suggested only when network cost is most of the fee', () => {
    const swapHeavy = buildFeeBreakdown({ amountUsd: 26.5, networkUsd: 1, swapUsd: 8, gas: [] })!;
    expect(swapHeavy.level).toBe('first');
    expect(swapHeavy.suggestWaiting).toBe(false);
    const gasHeavy = buildFeeBreakdown({ amountUsd: 26.5, networkUsd: 8, swapUsd: 1, gas: [] })!;
    expect(gasHeavy.suggestWaiting).toBe(true);
    expect(gasHeavy.networkShare).toBeCloseTo(8 / 9, 9);
  });

  test('a cross-chain action reports both chains, source first', () => {
    const b = buildFeeBreakdown({
      amountUsd: 26.5,
      networkUsd: 9,
      gas: [{ chainId: 56, gasPriceWei: 50_000_000n }, { chainId: 1, gasPriceWei: 1_234_000_000n }],
    })!;
    expect(b.gas).toEqual([{ chainId: 56, gwei: '0.05' }, { chainId: 1, gwei: '1.2' }]);
  });

  test('a part the action has but cannot price makes the total a lower bound', () => {
    const b = buildFeeBreakdown({ amountUsd: 20, networkUsd: 6, serviceUsd: 0.1, swapUsd: null, gas: [] })!;
    expect(b.unpriced).toEqual(['swap']);
    expect(b.totalUsd).toBeCloseTo(6.1, 9);
    expect(b.level).toBe('first');
    // Without the swap's share the network's share of the whole fee is unknown.
    expect(b.suggestWaiting).toBe(false);
  });

  test('a part the action does not have is not unpriced', () => {
    const b = buildFeeBreakdown({ amountUsd: 20, networkUsd: 6, serviceUsd: 0.1, gas: [] })!;
    expect(b.unpriced).toEqual([]);
    expect(b.suggestWaiting).toBe(true);
    expect(buildFeeBreakdown({ amountUsd: 20, networkUsd: Number.NaN, swapUsd: 1, gas: [] })!.unpriced).toEqual(['network']);
  });

  test('a fee on an amount under $100 reads in dollars, from $100 as a share of it', () => {
    const at = (amountUsd: number, config?: FeeWarningConfig) => buildFeeBreakdown({ amountUsd, networkUsd: 20, gas: [] }, config)!;
    expect(at(14.02).showPercent).toBe(false);
    expect(at(99.99).showPercent).toBe(false);
    expect(at(100).showPercent).toBe(true);
    expect(at(0.1 + 0.2 + 99.7).showPercent).toBe(true);
    // Display only: the level still follows the percentage.
    expect(at(99.99).level).toBe('first');
    expect(at(50, { ...FEE_WARNING_CONFIG, percentFromAmountUsd: 0 }).showPercent).toBe(true);
  });

  test('nothing to price is no breakdown', () => {
    expect(buildFeeBreakdown({ amountUsd: 10, networkUsd: null, gas: [] })).toBeNull();
    expect(buildFeeBreakdown({ amountUsd: null, networkUsd: 1, gas: [] })).toBeNull();
    expect(relayedSpendBreakdown({ chainId: 1, amountWei: 1n, feeWei: null, decimals: 6, tokenUsd: 1, gasUnits: 1n, gasPriceWei: 1n, nativeUsd: 1 })).toBeNull();
    expect(relayedSpendBreakdown({ chainId: 1, amountWei: 1n, feeWei: 1n, decimals: 6, tokenUsd: null, gasUnits: 1n, gasPriceWei: 1n, nativeUsd: 1 })).toBeNull();
  });

  test('without a gas reading the relayer fee still counts, all of it as network cost', () => {
    const b = relayedSpendBreakdown({ chainId: 1, amountWei: 10_000_000n, feeWei: 3_000_000n, decimals: 6, tokenUsd: 1, gasUnits: 850_000n, gasPriceWei: null, nativeUsd: 2500 })!;
    expect(b.networkUsd).toBe(3);
    expect(b.gas).toEqual([{ chainId: 1, gwei: null }]);
  });
});

describe('units', () => {
  test('quoteGas reads the relayer quote and refuses what it cannot', () => {
    expect(quoteGas({ gasPrice: '1000', txCost: '1050000' })).toEqual({ gasPriceWei: 1000n, gasUnits: 1_050_000n });
    expect(quoteGas({ gasPrice: '0', txCost: '0' })).toBeNull();
    expect(quoteGas({ gasPrice: 'x', txCost: '1' })).toBeNull();
    expect(quoteGas(null)).toBeNull();
    expect(quoteGas({})).toBeNull();
  });

  test('tokenUsd keeps precision past a float', () => {
    expect(tokenUsd(123_456_789_012_345_678_901n, 18, 2)).toBeCloseTo(246.913578024691357802, 9);
    expect(gasCostUsd(900_000n, 74_000_000n, 2500)).toBeCloseTo(0.1665, 9);
    expect(gasCostUsd(900_000n, null, 2500)).toBeNull();
  });

  test('swapLossUsd is never negative', () => {
    expect(swapLossUsd({ amount: 10n, decimals: 0, usd: 1 }, { amount: 11n, decimals: 0, usd: 1 })).toBe(0);
    expect(swapLossUsd({ amount: 10n, decimals: 0, usd: 1 }, { amount: 9n, decimals: 0, usd: 1 })).toBe(1);
    expect(swapLossUsd({ amount: 10n, decimals: 0, usd: 1 }, { amount: 9n, decimals: 0, usd: null })).toBeNull();
  });

  test('gwei and percentages read at a glance', () => {
    expect(formatGweiShort(74_084_139n)).toBe('0.074');
    expect(formatGweiShort(2_130_000n)).toBe('0.0021');
    expect(formatGweiShort(500_000_000n)).toBe('0.5');
    expect(formatGweiShort(12_430_000_000n)).toBe('12.4');
    expect(formatGweiShort(150_400_000_000n)).toBe('150');
    expect(formatFeePercent(31.4)).toBe('31%');
    expect(formatFeePercent(2.54)).toBe('2.5%');
    expect(formatFeePercent(3)).toBe('3%');
  });
});
