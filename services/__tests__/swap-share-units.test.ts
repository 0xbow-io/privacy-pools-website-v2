import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseUnits } from 'viem';

import { sdkErrorText, shareUnitsRate } from '@/services/sdk-error-amounts';
import { shareAmountFromUnderlying } from '@/services/share-amount-entry';
import type { ShareRate } from '@/services/share-rates';
import { quotedNetFigure } from '@/services/swap-quoted-net';

// Matthew's review on #26. ppUSDT: an 18-decimal share over a 6-decimal USDT,
// worth 1.05 each. The SDK's DepositBelowMinimum figures are share counts.
const RATE: ShareRate = {
  chainId: 1, share: '0xshare', underlying: '0xusdt', shareSymbol: 'ppUSDT', shareDecimals: 18,
  assetsPerShare: 1_050_000n, underlyingSymbol: 'USDT', underlyingDecimals: 6,
};
const SHARES = parseUnits('9.639123', 18);
const MIN = parseUnits('10', 18);
const PPUSDT = { symbol: 'ppUSDT', decimals: 18 };

function refusal() {
  const err = new Error(`Deposit value ${SHARES} is below the Entrypoint minimum ${MIN}`);
  (err as unknown as { amounts: unknown }).amounts = { code: 'depositBelowMinimum', side: 'received', values: { value: SHARES, minimum: MIN } };
  return err;
}
const units = (rate: ShareRate | undefined) => ({ output: { ...PPUSDT, rate: shareUnitsRate('ppUSDT', rate) } });

describe('P2 refused amount and minimum are converted to the underlying', () => {
  test('9.639123 shares at 1.05 read 10.12 USDT, the minimum 10.50 USDT', () => {
    expect(sdkErrorText(refusal(), units(RATE))).toBe(
      "This would deposit about 10.12 USDT, below the pool's minimum of 10.50 USDT. Try a larger amount.",
    );
  });
  test('the message-only path (no amounts field) converts too', () => {
    const plain = new Error(`Deposit value ${SHARES} is below the Entrypoint minimum ${MIN}`);
    expect(sdkErrorText(plain, units(RATE))).toContain('about 10.12 USDT');
    expect(sdkErrorText(plain, units(RATE))).toContain('minimum of 10.50 USDT');
  });
  test('no rate: loading, never the share count under the coin name', () => {
    const text = sdkErrorText(refusal(), units(undefined));
    expect(text).toBe("This would deposit about … USDT, below the pool's minimum of … USDT. Try a larger amount.");
    expect(text).not.toContain('9.63');
  });
  test('a plain token is untouched', () => {
    const err = new Error(`Deposit value ${SHARES} is below the Entrypoint minimum ${MIN}`);
    expect(sdkErrorText(err, { output: { decimals: 18, symbol: 'USDT', rate: shareUnitsRate('USDT', undefined) } }))
      .toContain('about 9.6391 USDT');
  });
  test('the headline reads the same number as the sentence', () => {
    expect(quotedNetFigure(SHARES, PPUSDT, RATE)).toEqual({ status: 'ready', text: '~10.12' });
  });
  test('the headline is loading while the rate is unavailable', () => {
    expect(quotedNetFigure(SHARES, PPUSDT, undefined)).toEqual({ status: 'loading' });
  });
  test('a plain stablecoin output keeps its two-decimal figure', () => {
    expect(quotedNetFigure(parseUnits('9.639123', 6), { symbol: 'USDC', decimals: 6 }, undefined)).toEqual({ status: 'ready', text: '~9.63' });
  });
});

describe('P2 the net figure is cleared when the form changes or resets', () => {
  const provider = readFileSync(new URL('../../components/swap-modal-provider.tsx', import.meta.url), 'utf8');
  const body = (start: string) => {
    const at = provider.indexOf(start);
    expect(at).toBeGreaterThan(0);
    return provider.slice(at, at + 4000);
  };
  test('every cancel of an outdated quote (slippage, amount, pair, destination, close) clears it', () => {
    expect(body('const invalidateQuoteRequests = useCallback')).toContain('setQuotedNet(null)');
    const slippage = body('const editSlippage = useCallback');
    expect(slippage).toContain('invalidateQuoteRequests()');
  });
  test('the form reset (reopen, context change) clears it', () => {
    expect(body('const resetState = useCallback')).toContain('setQuotedNet(null)');
  });
});

describe('P2 Swap amount is the coin it names', () => {
  const rate: ShareRate = { ...RATE, assetsPerShare: 1_050_000n };
  const enter = (text: string, cap: string, displayedMax = cap, clamp?: boolean) =>
    shareAmountFromUnderlying({ text, rate, maxSharesExact: cap, displayedMax, clamp });

  test('10 USDT at 1.05 is 9.523809523809523809 shares, not 10 shares', () => {
    expect(enter('10', '100', '105', false)).toBe('9.523809523809523809');
    // Floored: those shares are worth under 10 USDT, never over.
    expect(parseUnits('9.523809523809523809', 18) * rate.assetsPerShare / 10n ** 18n).toBeLessThanOrEqual(10_000_000n);
  });
  test('above the balance it is NOT cut to the balance, so the insufficient-balance error can answer it', () => {
    const cap = '5';
    const shares = enter('100', cap, '5.25', false);
    expect(parseUnits(shares, 18)).toBeGreaterThan(parseUnits(cap, 18));
    // Withdraw and Send still clamp.
    expect(enter('100', cap, '5.25')).toBe(cap);
    expect(enter('100', cap, '5.25', true)).toBe(cap);
  });
  test('typing the displayed MAX keeps the exact share cap (untouched MAX)', () => {
    expect(enter('5.25', '4.999999999999999999', '5.25', false)).toBe('4.999999999999999999');
  });
  test('the Swap field turns underlying entry on and the clamp off, and shows the flow error', () => {
    const hub = readFileSync(new URL('../../components/home/action-hub.tsx', import.meta.url), 'utf8');
    expect(hub).toContain("underlyingEntry: action === 'withdraw' || action === 'send' || action === 'swap'");
    expect(hub).toContain("clampToMax: action !== 'swap'");
    // Recommended deposits are Shield presets: they keep their fixed share targets.
    expect(hub).toContain("const next = a === 'withdraw' ? amountField.toShares(preset) : preset;");
  });
  test('a rate that is not there yet is unavailable, not 1:1', () => {
    const hook = readFileSync(new URL('../../hooks/use-share-amount-field.ts', import.meta.url), 'utf8');
    expect(hook).toContain('clamp: clampToMax');
    expect(hook).toContain('const waitingRate = !rate && underlyingEntry && isShareSymbol(symbol);');
  });
});
