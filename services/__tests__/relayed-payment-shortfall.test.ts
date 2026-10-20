import { describe, expect, test } from 'bun:test';
import { formatRelayedPaymentShortfall, formatShortfallAmount } from '../relayed-payment-shortfall';
import { parseUnits } from 'viem';

const e18 = (s: string) => BigInt(Math.round(Number(s) * 1e18));

describe('formatShortfallAmount', () => {
  test('rounds a cost up and a balance down to 4 significant digits', () => {
    expect(formatShortfallAmount(42_500_000_021_000n, 18, true)).toBe('0.00004251');
    expect(formatShortfallAmount(42_500_000_021_000n, 18, false)).toBe('0.0000425');
    expect(formatShortfallAmount(1_098_148_975_083_278n, 18, false)).toBe('0.001098');
    expect(formatShortfallAmount(1_500_000n, 6, true)).toBe('1.5');
    expect(formatShortfallAmount(0n, 18, true)).toBe('0');
  });
});

describe('formatRelayedPaymentShortfall', () => {
  // The BNB case QA hit on 2026-10-15.
  const qa = {
    requestedAmount: 1_674_380_000_000_000n,
    relayerFee: 42_500_000_021_000n,
    reachableAmount: 1_098_148_975_083_278n,
    lineageBlindAmount: 1_098_148_975_083_278n,
    totalSpendable: 1_098_148_975_083_278n,
    tokenSymbol: 'BNB',
    decimals: 18,
    maxLabels: 2,
    singleDepositTopUp: 618_731_024_937_722n,
  };

  test('short on value: short copy, no wei-level numbers, no em dash', () => {
    const msg = formatRelayedPaymentShortfall(qa);
    expect(msg).toBe(
      "Your balance isn't high enough. This payment needs 0.001717 BNB. You can use up to 0.001098 BNB. Shield at least 0.0006188 BNB in one deposit, or ask for a smaller amount.",
    );
    expect(msg).not.toContain('—');
    expect(msg).not.toMatch(/\d\.\d{9,}/);
  });

  test('the shield number never undershoots the exact top-up', () => {
    const msg = formatRelayedPaymentShortfall(qa);
    const shown = msg.match(/Shield at least ([\d.]+)/)![1];
    expect(e18(shown) >= qa.singleDepositTopUp).toBe(true);
  });

  test('single-lineage and split cases name their cause', () => {
    expect(formatRelayedPaymentShortfall({ ...qa, maxLabels: 1, lineageBlindAmount: e18('1'), totalSpendable: e18('1') }))
      .toContain('can only use one deposit');
    // maxLabels 2 must never claim the one-deposit rule (cubic review).
    expect(formatRelayedPaymentShortfall({ ...qa, lineageBlindAmount: e18('1'), totalSpendable: e18('1') }))
      .toContain('one payment can only use up to 0.001098 BNB');
    expect(formatRelayedPaymentShortfall({ ...qa, totalSpendable: e18('1') }))
      .not.toContain('can only use one deposit');
  });

  test('unknown fee never names a number to shield', () => {
    const msg = formatRelayedPaymentShortfall({ ...qa, relayerFee: null });
    expect(msg).not.toContain('Shield');
    expect(msg).not.toMatch(/wallet/i);
  });
});

describe('stablecoin shortfall copy (Mike, #282)', () => {
  const e6 = (n: number) => BigInt(Math.round(n * 1e6));
  const fdusd = (n: string) => parseUnits(n, 18);

  test('2 decimals: "can use" rounds down, "needs" and "shield" round up', () => {
    const msg = formatRelayedPaymentShortfall({
      requestedAmount: fdusd('10.00'),
      relayerFee: fdusd('0.03111'),
      reachableAmount: fdusd('7.777'),
      lineageBlindAmount: fdusd('7.777'),
      totalSpendable: fdusd('7.777'),
      tokenSymbol: 'FDUSD',
      decimals: 18,
      maxLabels: 2,
      singleDepositTopUp: fdusd('10.03001'),
    });
    expect(msg).toBe(
      "Your balance isn't high enough. This payment needs 10.04 FDUSD. You can use up to 7.77 FDUSD. Shield at least 10.04 FDUSD in one deposit, or ask for a smaller amount.",
    );
    expect(msg).not.toContain('relayer fee');
  });

  test('stablecoin rounding directions at 6 decimals', () => {
    expect(formatShortfallAmount(e6(7.779), 6, false, 'USDC')).toBe('7.77');
    expect(formatShortfallAmount(e6(7.771), 6, true, 'USDC')).toBe('7.78');
    expect(formatShortfallAmount(e6(7.77), 6, true, 'USDC')).toBe('7.77');
    expect(formatShortfallAmount(e6(0.001), 6, true, 'USDT')).toBe('0.01');
  });

  test('non-stable assets keep 4 significant digits with the same directions', () => {
    expect(formatShortfallAmount(1_098_948_975_083_278n, 18, false, 'BNB')).toBe('0.001098');
    expect(formatShortfallAmount(1_098_048_975_083_278n, 18, true, 'BNB')).toBe('0.001099');
    expect(formatShortfallAmount(1_098_048_975_083_278n, 18, true, 'ETH'))
      .toBe(formatShortfallAmount(1_098_048_975_083_278n, 18, true));
  });
});

describe('translateSdkTransactError shortfall copy', () => {
  test('same opener, costs up, held down, stablecoin at 2 decimals', async () => {
    const { translateSdkTransactError } = await import('../transfer-outcome');
    const msg = translateSdkTransactError(
      `Insufficient value for transact: available=0x${(7_779_000n).toString(16)}, requested=0x${(10_031_100n).toString(16)}`,
      { symbol: 'USDC', decimals: 6 },
    );
    expect(msg).toContain("Your balance isn't high enough. This payment needs 10.04 USDC. The notes selected for it hold 7.77 USDC. You are 2.26 USDC short.");
  });
});
