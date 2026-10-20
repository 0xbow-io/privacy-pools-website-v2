import { expect, test } from 'bun:test';
import { requestWalletRefusal } from '@/services/request-wallet-rule';
import { poolVisible } from '@/services/pool-visibility-rule';
import { usesNativeWithdrawPresets } from '@/services/withdraw-preset-rule';
import { tokenAmountLabel } from '@/services/share-display';
test('deposit-for rejects configured legacy native and shares before wallet funding', () => {
  expect(requestWalletRefusal({ symbol: 'ETH', isNative: true }, true)).toContain('yield vault');
  expect(requestWalletRefusal({ symbol: 'ETH', isNative: true }, false)).toBeNull();
  expect(requestWalletRefusal({ symbol: 'ppETH', isNative: false, yieldShare: true }, true)).toContain('shielded ETH');
  expect(requestWalletRefusal({ symbol: 'ppUSDC', isNative: false, yieldShare: true }, false)).not.toContain('ppUSDC');
  expect(requestWalletRefusal({ symbol: 'USDC', isNative: false, withdrawOnly: true }, false)).toContain('closed');
});
test('directory hides only empty superseded pools other than the current page', () => {
  expect(poolVisible({ superseded: true, active: 0, pending: 0 })).toBe(false);
  for (const override of [{ active: 1 }, { pending: 1 }, { current: true }, { superseded: false }]) {
    expect(poolVisible({ superseded: true, active: 0, pending: 0, ...override })).toBe(true);
  }
});
test('native presets follow displayed ETH, SUI and cBTC; share sizing remains raw', () => {
  for (const symbol of ['ETH', 'ppETH', 'PPETH', 'WETH', 'SUI', 'cBTC']) expect(usesNativeWithdrawPresets(symbol)).toBe(true);
  for (const symbol of ['ppUSDC', 'ppUSDT', 'USDC']) expect(usesNativeWithdrawPresets(symbol)).toBe(false);
});
test('raw share quantities get approximate coin labels without changing their units', () => {
  expect(tokenAmountLabel('0.123456789012345678', 'ppETH')).toBe('≈ 0.123456789012345678 ETH');
  expect(tokenAmountLabel('5', 'ppUSDC')).toBe('≈ 5 USDC');
  expect(tokenAmountLabel('1', 'WETH')).toBe('1 ETH');
});
