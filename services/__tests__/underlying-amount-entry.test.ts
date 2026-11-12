import { describe, test, expect } from 'bun:test';
import { parseUnits } from 'viem';

import { sharesForUnderlyingCeil, underlyingForSharesFloor, deliveredMatchesExpected } from '@/services/underlying-amount-entry';
import { shareBalanceDisplay } from '@/services/share-balance-display';
import { ceilFeeToDisplayGrain, splitRelayFee } from '@/services/relay-fee-split';
import type { ShareRate } from '@/services/share-rates';

// A USDT vault share: 18-decimal share over a 6-decimal coin. 1.005420 is the
// rate of the 2026-11-08 incident: 1018.40 read as a share count was worth
// 1023.92 USDT (DEV-622).
function rate(assetsPerShare: bigint, over: Partial<ShareRate> = {}): ShareRate {
  return {
    chainId: 1,
    share: '0xshare',
    underlying: '0xusdt',
    shareSymbol: 'ppUSDT',
    shareDecimals: 18,
    assetsPerShare,
    underlyingSymbol: 'USDT',
    underlyingDecimals: 6,
    ...over,
  };
}

const INCIDENT = rate(1_005_420n);

describe('payroll salary to pool units (DEV-622)', () => {
  test('the incident: a 1,018.40 USDT salary is NOT sent as 1,018.40 shares', () => {
    // What the old handoff did: the salary string used as the share count.
    expect(underlyingForSharesFloor('1018.4', INCIDENT)).toBe('1023.919728');
    // What it does now: shares worth the salary.
    const shares = sharesForUnderlyingCeil('1018.40', INCIDENT)!;
    expect(shares).not.toBe('1018.4');
    expect(Number(shares)).toBeLessThan(1013);
    expect(underlyingForSharesFloor(shares, INCIDENT)).toBe('1018.4');
  });

  test('rounds up at share granularity: the payee never gets less than the salary', () => {
    for (const aps of [1_000_000n, 1_005_420n, 1_005_400n, 1_234_567n, 999_999n, 1_000_001n, 7n * 10n ** 5n]) {
      for (const salary of ['1018.40', '0.01', '5', '4200', '123456.789012', '0.000001']) {
        const r = rate(aps);
        const shares = sharesForUnderlyingCeil(salary, r)!;
        const delivered = underlyingForSharesFloor(shares, r)!;
        const got = parseUnits(delivered, 6);
        const want = parseUnits(salary, 6);
        expect(got >= want).toBe(true);
        // At most one coin base unit over, which the payroll row check allows.
        expect(got <= want + 1n).toBe(true);
        expect(deliveredMatchesExpected({ delivered, expected: salary, decimals: 6 })).toBe(true);
        // One share base unit less would have paid out less than the salary.
        const oneLess = parseUnits(shares, 18) - 1n;
        expect(oneLess * aps / 10n ** 18n < want).toBe(true);
      }
    }
  });

  test('a rate of exactly 1 is the identity', () => {
    expect(sharesForUnderlyingCeil('1018.40', rate(1_000_000n))).toBe('1018.4');
  });

  test('an 18-decimal coin over an 18-decimal share (ETH): within one base unit', () => {
    const eth = rate(1_031_234_567_890_123_457n, { shareSymbol: 'ppETH', underlyingSymbol: 'WETH', underlyingDecimals: 18 });
    const shares = sharesForUnderlyingCeil('0.5', eth)!;
    const got = parseUnits(underlyingForSharesFloor(shares, eth)!, 18);
    expect(got >= 5n * 10n ** 17n && got <= 5n * 10n ** 17n + 1n).toBe(true);
  });

  test('refuses what cannot be sent exactly', () => {
    expect(sharesForUnderlyingCeil('1018.4000001', INCIDENT)).toBeNull(); // 7 decimals on a 6-decimal coin
    expect(sharesForUnderlyingCeil('0', INCIDENT)).toBeNull();
    expect(sharesForUnderlyingCeil('abc', INCIDENT)).toBeNull();
    expect(sharesForUnderlyingCeil('1e3', INCIDENT)).toBeNull();
    expect(sharesForUnderlyingCeil('10', rate(0n))).toBeNull();
  });

  test('the row check accepts the salary and refuses a share count', () => {
    const d = (delivered: string | null) => deliveredMatchesExpected({ delivered, expected: '1018.4', decimals: 6 });
    expect(d('1018.4')).toBe(true);
    expect(d('1018.400001')).toBe(true);
    expect(d('1018.399999')).toBe(false); // underpaid
    expect(d('1018.400002')).toBe(false);
    expect(d('1023.919728')).toBe(false); // the overpay
    expect(d(null)).toBe(false);
  });
});

describe('recipient, fee and total read the same in the coin', () => {
  const view = (shares: bigint) => shareBalanceDisplay({
    sharesExact: (Number(shares) === 0 ? '0' : `${shares / 10n ** 18n}.${(shares % 10n ** 18n).toString().padStart(18, '0')}`),
    shareSymbol: 'ppUSDT',
    rate: INCIDENT,
    priceMap: undefined,
    fallbackPrice: 0,
  });

  test('1018.40 + 0.07 = 1018.47 with two decimals', () => {
    const recipient = parseUnits(sharesForUnderlyingCeil('1018.40', INCIDENT)!, 18);
    // A fee estimate worth ~0.0749 USDT in share units, ceiled to the display grain.
    const fee = ceilFeeToDisplayGrain(parseUnits(sharesForUnderlyingCeil('0.0749', INCIDENT)!, 18), 18);
    const split = splitRelayFee({ entered: recipient, feeWei: fee, grain: 10n ** 12n, sendExact: false });
    expect(split.recipientWei).toBe(recipient);
    expect(split.totalDebitWei).toBe(recipient + fee);
    expect(view(split.recipientWei).text).toBe('1018.40 USDT');
    expect(view(fee).text).toBe('0.07 USDT');
    expect(view(split.totalDebitWei).text).toBe('1018.47 USDT');
  });

  test('ceilFeeToDisplayGrain never understates and uses the 6 decimal grain', () => {
    expect(ceilFeeToDisplayGrain(1n, 18)).toBe(10n ** 12n);
    expect(ceilFeeToDisplayGrain(10n ** 12n, 18)).toBe(10n ** 12n);
    expect(ceilFeeToDisplayGrain(1_000_001n * 10n ** 12n - 1n, 18)).toBe(1_000_001n * 10n ** 12n);
    expect(ceilFeeToDisplayGrain(123n, 6)).toBe(123n); // a 6-decimal coin is already at the grain
  });
});
