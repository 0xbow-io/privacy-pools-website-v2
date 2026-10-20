import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  NATIVE_SWAP_EXECUTOR_CHAIN_IDS,
  isNativeSwapDepositUnavailable,
  nativeSwapDepositSupported,
} from '@/services/native-swap-executor';
import { conversionTargetRefusal, targetAcceptsConversion } from '@/services/entrypoint-only-route';

describe('native swap executor chains', () => {
  test('matches the vendored SDK executor table', () => {
    // LIFI_SWAP_EXECUTORS is internal to the bundle (not exported), so read
    // the table's chain-id keys out of the vendored build itself.
    const bundle = readFileSync(require.resolve('@privacy-pools-v2/sdk'), 'utf8');
    const table = /LIFI_SWAP_EXECUTORS = \{([\s\S]*?)\n\};/.exec(bundle)?.[1];
    expect(table).toBeTruthy();
    const fromSdk = [...table!.matchAll(/^\s{2}(\d+): \{/gm)].map((m) => Number(m[1])).sort((a, b) => a - b);
    expect(fromSdk.length).toBeGreaterThan(0);
    expect([...NATIVE_SWAP_EXECUTOR_CHAIN_IDS].sort((a, b) => a - b)).toEqual(fromSdk);
  });

  test('answers per chain', () => {
    expect(nativeSwapDepositSupported(56)).toBe(true);
    expect(nativeSwapDepositSupported(11155111)).toBe(false);
  });

  test('recognises the typed SDK error by name', () => {
    const err = new Error('A swap into a native-coin deposit cannot be built: no executor.');
    err.name = 'NativeSwapDepositUnavailable';
    expect(isNativeSwapDepositUnavailable(err)).toBe(true);
    expect(isNativeSwapDepositUnavailable(new Error('other'))).toBe(false);
    expect(isNativeSwapDepositUnavailable('NativeSwapDepositUnavailable')).toBe(false);
  });

  test('a plain native target is refused only where no executor exists', () => {
    const bnb = { symbol: 'BNB', isNative: true };
    expect(targetAcceptsConversion(bnb, { chainId: 56, nativeSwapDeposit: true })).toBe(true);
    expect(targetAcceptsConversion(bnb, { chainId: 999, nativeSwapDeposit: false })).toBe(false);
    expect(conversionTargetRefusal(bnb, { chainId: 999, nativeSwapDeposit: false })).toMatch(/not available on this network/);
    // Unknown (not stated) keeps the old behaviour.
    expect(targetAcceptsConversion(bnb, { chainId: 999 })).toBe(true);
    // ERC-20 targets never need the executor.
    expect(targetAcceptsConversion({ symbol: 'USDT' }, { chainId: 999, nativeSwapDeposit: false })).toBe(true);
  });
});

describe('sdkErrorText maps NativeSwapDepositUnavailable', () => {
  test('shows the clear copy instead of the SDK sentence', async () => {
    const { sdkErrorText } = await import('@/services/sdk-error-amounts');
    const { NATIVE_SWAP_DEPOSIT_UNAVAILABLE_TEXT } = await import('@/services/native-swap-executor');
    const err = new Error('A swap into a native-coin deposit (0xeeee, 1) cannot be built: no swap executor.');
    err.name = 'NativeSwapDepositUnavailable';
    expect(sdkErrorText(err, null)).toBe(NATIVE_SWAP_DEPOSIT_UNAVAILABLE_TEXT);
  });
});
