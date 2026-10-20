import { describe, expect, test } from 'bun:test';
import { resolveRelayerFee, feeSanity, feeSanityMessage } from '../relayer-fee';

const USDC = { symbol: 'USDC', decimals: 6, address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' };
const ETH = { symbol: 'ETH', decimals: 18 };
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const lookup = (address: string) => {
  const a = address.toLowerCase();
  if (a === NATIVE.toLowerCase()) return ETH;
  if (a === USDC.address.toLowerCase()) return { symbol: 'USDC', decimals: 6 };
  return undefined;
};

describe('resolveRelayerFee', () => {
  test('uses the withdrawn token when the quote names the same asset', () => {
    const fee = resolveRelayerFee({
      feeAmount: '499312', // 0.499312 USDC at 6dp
      feeAsset: USDC.address,
      withdrawToken: USDC,
      lookupAsset: lookup,
    });
    expect(fee.symbol).toBe('USDC');
    expect(fee.amount).toBeCloseTo(0.499312, 6);
    expect(fee.isForeignAsset).toBe(false);
    expect(fee.text).toBe('0.4993 USDC');
  });

  test("a fee charged in the NATIVE asset is not relabelled as the withdrawn token", () => {
    // The reported bug's shape: ETH-denominated fee formatted at USDC's 6dp
    // read as 499312.7542 USDC. With the quote's own asset it is ETH at 18dp.
    const fee = resolveRelayerFee({
      feeAmount: '499312754200000', // 0.0004993 ETH
      feeAsset: NATIVE,
      withdrawToken: USDC,
      lookupAsset: lookup,
    });
    expect(fee.symbol).toBe('ETH');
    expect(fee.decimals).toBe(18);
    expect(fee.isForeignAsset).toBe(true);
    expect(fee.amount).toBeCloseTo(0.0004993, 7);
    // The old code would have produced 499312754.2 USDC from these same bytes.
    const wrong = Number(BigInt('499312754200000')) / 10 ** 6;
    expect(wrong).toBeGreaterThan(1_000_000);
  });

  test('falls back to the withdrawn token when the quote carries no asset', () => {
    const fee = resolveRelayerFee({
      feeAmount: '499312', feeAsset: null, withdrawToken: USDC, lookupAsset: lookup,
    });
    expect(fee.symbol).toBe('USDC');
    expect(fee.isForeignAsset).toBe(false);
  });

  test('an unknown fee asset falls back rather than inventing a symbol', () => {
    const fee = resolveRelayerFee({
      feeAmount: '499312', feeAsset: '0xdead', withdrawToken: USDC, lookupAsset: lookup,
    });
    expect(fee.symbol).toBe('USDC');
  });

  test('two contracts sharing a symbol are still different assets', () => {
    const otherUsdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const fee = resolveRelayerFee({
      feeAmount: '1',
      feeAsset: otherUsdc,
      withdrawToken: USDC,
      lookupAsset: (a) => (a.toLowerCase() === otherUsdc.toLowerCase() ? { symbol: 'USDC', decimals: 6 } : lookup(a)),
    });
    expect(fee.isForeignAsset).toBe(true);
  });

  test('address comparison is case-insensitive', () => {
    const fee = resolveRelayerFee({
      feeAmount: '1', feeAsset: USDC.address.toUpperCase(), withdrawToken: USDC, lookupAsset: lookup,
    });
    expect(fee.isForeignAsset).toBe(false);
  });

  test('a malformed feeAmount reads as zero, never NaN', () => {
    const fee = resolveRelayerFee({
      feeAmount: 'not-a-number', feeAsset: USDC.address, withdrawToken: USDC, lookupAsset: lookup,
    });
    expect(fee.amount).toBe(0);
    expect(Number.isNaN(fee.amount)).toBe(false);
  });
});

describe('feeSanity', () => {
  test('a normal fee is ok', () => {
    expect(feeSanity({ feeAmount: 0.5, withdrawAmount: 5 })).toBe('ok');
  });

  test('a fee equal to or above the amount leaves nothing', () => {
    expect(feeSanity({ feeAmount: 5, withdrawAmount: 5 })).toBe('exceeds-amount');
    expect(feeSanity({ feeAmount: 6, withdrawAmount: 5 })).toBe('exceeds-amount');
  });

  test("Artem's card is classified implausible, not merely over-amount", () => {
    // 499312.75 USDC quoted against a 5 USDC withdrawal — a unit error, and the
    // user cannot fix it by withdrawing more, so it gets its own message.
    expect(feeSanity({ feeAmount: 499312.7542, withdrawAmount: 5 })).toBe('implausible');
  });

  test('an empty form is not a bad quote', () => {
    expect(feeSanity({ feeAmount: 0.5, withdrawAmount: 0 })).toBe('ok');
  });

  test('negative or non-finite fees are implausible', () => {
    expect(feeSanity({ feeAmount: -1, withdrawAmount: 5 })).toBe('implausible');
    expect(feeSanity({ feeAmount: Number.NaN, withdrawAmount: 5 })).toBe('implausible');
  });
});

describe('feeSanityMessage', () => {
  const fee = { amount: 499312.7542, symbol: 'USDC', decimals: 6, isForeignAsset: false, text: '499312.7542 USDC' };

  test('ok has no message', () => {
    expect(feeSanityMessage('ok', fee)).toBeNull();
  });

  test('both refusals name the quoted fee and say nothing was submitted', () => {
    for (const s of ['exceeds-amount', 'implausible'] as const) {
      const msg = feeSanityMessage(s, fee)!;
      expect(msg).toContain('499312.7542 USDC');
      expect(msg.toLowerCase()).toContain('not submitted');
    }
  });
});
