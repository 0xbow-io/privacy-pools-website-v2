// The Request field is an amount of the COIN (its label says so). It converts to
// exact shares once, at creation, rounded UP, and the link keeps those shares.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseUnits } from 'viem';
import { requestAmountInPoolUnits, requestRateMissing } from '@/services/payment-request-amount';
import { underlyingForSharesFloor } from '@/services/underlying-amount-entry';
import { linkAmountText, type LinkToken } from '@/services/link-token';
import type { ShareRate } from '@/services/share-rates';

const rate = (assetsPerShare: bigint, over: Partial<ShareRate> = {}): ShareRate => ({
  chainId: 1,
  share: '0xshare',
  underlying: '0xusdt',
  shareSymbol: 'ppUSDT',
  shareDecimals: 18,
  assetsPerShare,
  underlyingSymbol: 'USDT',
  underlyingDecimals: 6,
  ...over,
});
const PP_USDT: LinkToken = { known: true, symbol: 'ppUSDT', decimals: 18 };

describe('request amount in pool units', () => {
  test('rate 1.05: typing 100 USDT asks for 95.238... shares, not 100 shares', () => {
    const out = requestAmountInPoolUnits({ text: '100', symbol: 'ppUSDT', rate: rate(1_050_000n) });
    expect(out).toEqual({ ok: true, units: '95.238095238095238096' });
  });

  test('the old reading (typed text as a share count) is gone: 100 does not stay 100', () => {
    const out = requestAmountInPoolUnits({ text: '100', symbol: 'ppUSDT', rate: rate(1_050_000n) });
    expect(out.ok && out.units).not.toBe('100');
  });

  test('rounds UP: the share count redeems for at least what was typed, at most one share unit more', () => {
    for (const aps of [1_050_000n, 1_005_420n, 1_234_567n, 999_999n, 1_000_001n, 1_070_001n]) {
      for (const text of ['100', '0.01', '5', '1018.40', '12345.678901']) {
        const r = rate(aps);
        const out = requestAmountInPoolUnits({ text, symbol: 'ppUSDT', rate: r });
        expect(out.ok).toBe(true);
        if (!out.ok) continue;
        const shares = parseUnits(out.units, 18);
        const typed = parseUnits(text, 6);
        // value of the shares, exact (no flooring): shares * aps / 1e18 >= typed
        expect(shares * aps >= typed * 10n ** 18n).toBe(true);
        // and one share unit fewer would under-ask
        expect((shares - 1n) * aps < typed * 10n ** 18n).toBe(true);
      }
    }
  });

  test('what a payer sees for the link is the typed amount (rounded down to 2 decimals)', () => {
    const r = rate(1_050_000n);
    const out = requestAmountInPoolUnits({ text: '100', symbol: 'ppUSDT', rate: r });
    if (!out.ok) throw new Error('expected a conversion');
    expect(underlyingForSharesFloor(out.units, r)).toBe('100');
    expect(linkAmountText(parseUnits(out.units, 18), PP_USDT, r)).toBe('100.00 USDT');
  });

  test('the link keeps the converted share amount exactly (hex amount round trip, old links decode as before)', () => {
    const out = requestAmountInPoolUnits({ text: '100', symbol: 'ppUSDT', rate: rate(1_050_000n) });
    if (!out.ok) throw new Error('expected a conversion');
    const amountHex = `0x${parseUnits(out.units, 18).toString(16)}`;
    expect(BigInt(amountHex)).toBe(95238095238095238096n);
    // a link made before this change carried typed-as-shares units: still just a share amount
    expect(linkAmountText(BigInt(`0x${parseUnits('100', 18).toString(16)}`), PP_USDT, rate(1_050_000n))).toBe('105.00 USDT');
  });

  test('the create path converts through this module, never parseUnits on the typed text', () => {
    const source = readFileSync(new URL('../../components/payment-request-modal-provider.tsx', import.meta.url), 'utf8');
    expect(source).toContain('requestAmountInPoolUnits(');
    expect(source).not.toContain('parseUnits(amountInput, selectedToken.decimals)');
  });

  test('rate unavailable: nothing is converted, never the typed number as shares', () => {
    expect(requestAmountInPoolUnits({ text: '100', symbol: 'ppUSDT', rate: undefined })).toEqual({ ok: false, reason: 'rate-unavailable' });
    expect(requestAmountInPoolUnits({ text: '100', symbol: 'ppUSDT', rate: rate(0n) })).toEqual({ ok: false, reason: 'rate-unavailable' });
    expect(requestRateMissing('ppUSDT', undefined)).toBe(true);
    expect(requestRateMissing('ppUSDT', rate(1_050_000n))).toBe(false);
  });

  test('a zero, empty or over-precise coin amount is invalid', () => {
    const r = rate(1_050_000n);
    expect(requestAmountInPoolUnits({ text: '0', symbol: 'ppUSDT', rate: r })).toEqual({ ok: false, reason: 'invalid' });
    expect(requestAmountInPoolUnits({ text: '', symbol: 'ppUSDT', rate: r })).toEqual({ ok: false, reason: 'invalid' });
    expect(requestAmountInPoolUnits({ text: '1.0000001', symbol: 'ppUSDT', rate: r })).toEqual({ ok: false, reason: 'invalid' });
  });

  test('a plain token is unchanged, with or without a rate', () => {
    expect(requestAmountInPoolUnits({ text: '100', symbol: 'USDC', rate: undefined })).toEqual({ ok: true, units: '100' });
    expect(requestAmountInPoolUnits({ text: ' 0.5 ', symbol: 'ETH', rate: rate(1_050_000n) })).toEqual({ ok: true, units: '0.5' });
    expect(requestRateMissing('USDC', undefined)).toBe(false);
  });

  test('ppETH: 18-over-18 decimals, rate 1.02, 1 ETH', () => {
    const r = rate(1_020_000_000_000_000_000n, { shareSymbol: 'ppETH', underlyingSymbol: 'ETH', underlyingDecimals: 18 });
    const out = requestAmountInPoolUnits({ text: '1', symbol: 'ppETH', rate: r });
    // 1 / 1.02 = 0.980392156862745098039..., ceiled at 18 decimals
    expect(out).toEqual({ ok: true, units: '0.980392156862745099' });
  });
});
