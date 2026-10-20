import { describe, expect, test } from 'bun:test';
import { formatFeeUnits, netAfterReserve, relayFeeReserve, splitRelayFee } from '../relay-fee-split';

const ETH = (s: string) => BigInt(Math.round(parseFloat(s) * 1e6)) * 10n ** 12n; // 6dp -> 18 decimals
const GRAIN_18 = 10n ** 12n; // the app's 6-decimal display grain for an 18-dec token
const GRAIN_6 = 1n; // USDC: 6 decimals, grain 1

describe('relayFeeReserve', () => {
  test('adds 25% headroom, the same reserve the input-selection budget uses', () => {
    expect(relayFeeReserve(1_000n)).toBe(1_250n);
    expect(relayFeeReserve(0n)).toBe(0n);
    // Integer division truncates; the reserve is never below the fee.
    expect(relayFeeReserve(3n)).toBe(3n);
    expect(relayFeeReserve(7n)).toBeGreaterThanOrEqual(7n);
  });
});

describe('netAfterReserve', () => {
  test('floors to the grain so the displayed figure is exactly what is sent', () => {
    // 0.01 - 0.000671 = 0.009329 -> floored to 6dp stays 0.009329
    expect(netAfterReserve(ETH('0.01'), ETH('0.000671'), GRAIN_18)).toBe(ETH('0.009329'));
    // A sub-grain remainder is dropped, never rounded up.
    expect(netAfterReserve(1_000_500n, 500n, 1_000n)).toBe(1_000_000n);
  });

  test('never returns below zero, and treats a zero grain as 1', () => {
    expect(netAfterReserve(100n, 100n, GRAIN_6)).toBe(0n);
    expect(netAfterReserve(100n, 250n, GRAIN_6)).toBe(0n);
    expect(netAfterReserve(100n, 40n, 0n)).toBe(60n);
  });
});

describe('splitRelayFee: fee on top (the default)', () => {
  test('the recipient gets the typed amount and the sender pays it plus the fee', () => {
    const split = splitRelayFee({ entered: ETH('0.01'), feeWei: ETH('0.000537'), grain: GRAIN_18, sendExact: false });
    expect(split.recipientWei).toBe(ETH('0.01'));
    expect(split.totalDebitWei).toBe(ETH('0.010537'));
    expect(split.belowFee).toBe(false);
  });

  test('this is exactly why a whole balance cannot be sent: total exceeds it', () => {
    const balance = ETH('0.01');
    const split = splitRelayFee({ entered: balance, feeWei: ETH('0.000537'), grain: GRAIN_18, sendExact: false });
    expect(split.totalDebitWei > balance).toBe(true);
  });
});

describe('splitRelayFee: send exact', () => {
  test('the typed amount is the whole debit and the recipient gets it minus the reserve', () => {
    // The reported case: balance 0.01, fee 0.000537 -> reserve 0.000671(25),
    // so 0.01 leaves the balance and ~0.009328 arrives.
    const balance = ETH('0.01');
    const split = splitRelayFee({ entered: balance, feeWei: ETH('0.000537'), grain: GRAIN_18, sendExact: true });
    expect(split.totalDebitWei).toBe(balance);
    expect(split.totalDebitWei <= balance).toBe(true); // the whole point: it fits
    expect(split.recipientWei).toBe(ETH('0.009328'));
    expect(split.reserveWei).toBe(relayFeeReserve(ETH('0.000537')));
    expect(split.belowFee).toBe(false);
  });

  test('a fee re-quote up to 25% higher still fits inside the typed amount', () => {
    const entered = ETH('0.01');
    const quoted = ETH('0.000537');
    const split = splitRelayFee({ entered, feeWei: quoted, grain: GRAIN_18, sendExact: true });
    // Worst case the relay charges the full reserve; the debit is then exactly
    // the recipient amount plus that fee, which must not exceed what was typed.
    expect(split.recipientWei + relayFeeReserve(quoted) <= entered).toBe(true);
  });

  test('an amount at or under the fee is refused rather than sending nothing', () => {
    const split = splitRelayFee({ entered: ETH('0.0005'), feeWei: ETH('0.000537'), grain: GRAIN_18, sendExact: true });
    expect(split.recipientWei).toBe(0n);
    expect(split.belowFee).toBe(true);
  });

  test('zero entered is not an error, just nothing to split', () => {
    const split = splitRelayFee({ entered: 0n, feeWei: ETH('0.000537'), grain: GRAIN_18, sendExact: true });
    expect(split.recipientWei).toBe(0n);
    expect(split.belowFee).toBe(false);
  });

  test('works on a 6-decimal token (USDC) where the grain is 1', () => {
    const entered = 10_000_000n; // 10 USDC
    const fee = 120_000n; // 0.12 USDC
    const split = splitRelayFee({ entered, feeWei: fee, grain: GRAIN_6, sendExact: true });
    expect(split.totalDebitWei).toBe(entered);
    expect(split.recipientWei).toBe(entered - relayFeeReserve(fee));
  });
});

describe('splitRelayFee: no quote yet', () => {
  test('reports the typed amount unchanged, with no reserve and no error', () => {
    for (const sendExact of [true, false]) {
      const split = splitRelayFee({ entered: ETH('0.01'), feeWei: null, grain: GRAIN_18, sendExact });
      expect(split.recipientWei).toBe(ETH('0.01'));
      expect(split.totalDebitWei).toBe(ETH('0.01'));
      expect(split.reserveWei).toBeNull();
      expect(split.belowFee).toBe(false);
    }
  });
});

describe('formatFeeUnits', () => {
  test('keeps a fee the balance formatter would round away', () => {
    // 0.000540121785021 ETH: a real relayer transfer quote. The 4-dp balance
    // formatter renders this "0.0005", which cannot be added up.
    expect(formatFeeUnits(540121785021000n, 18)).toBe('0.00054012');
  });

  test('trims trailing zeros and drops an empty fraction', () => {
    expect(formatFeeUnits(500000000000000n, 18)).toBe('0.0005');
    expect(formatFeeUnits(10n ** 18n, 18)).toBe('1');
    expect(formatFeeUnits(0n, 18)).toBe('0');
  });

  test('a fee under the display threshold is a figure, not "<0.0001"', () => {
    expect(formatFeeUnits(30000000000n, 18)).toBe('0.00000003');
  });

  test('a fee below the decimal cap rounds to nothing rather than lying', () => {
    // 1 wei has no representation within 8 decimals: better an honest 0 than a
    // fabricated digit.
    expect(formatFeeUnits(1n, 18)).toBe('0');
  });

  test('respects the token decimals (USDC has 6)', () => {
    expect(formatFeeUnits(1500n, 6)).toBe('0.0015');
    expect(formatFeeUnits(2500000n, 6)).toBe('2.5');
  });
});
