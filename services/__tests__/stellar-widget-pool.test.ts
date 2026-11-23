import { expect, mock, test } from 'bun:test';
mock.module('react-native', () => ({ Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default } }));
process.env.EXPO_PUBLIC_APP_ENV = 'staging';
const { stellarWidgetPools } = await import('../stellar-widget-pool');
const { STELLAR_TESTNET_CONTRACTS } = await import('../../config/stellar-deployment');
const { listShieldPools } = await import('../shield-pools');
const { crossChainSwapDepositSupported, crossChainReshieldSupported, getSwapInputTokens, getSwapOutputTokens } = await import('../../config/intent-swaps');

test('staging widget offers only native XLM on Stellar, independently of EVM conversion pools', () => {
  expect(stellarWidgetPools()).toEqual([{
    chainId: 202, chainName: 'Stellar Testnet', symbol: 'XLM', decimals: 7,
    address: STELLAR_TESTNET_CONTRACTS.nativeAssetContractId,
  }]);
  expect(listShieldPools().some(p => p.chainId === 202)).toBe(false);
});

test('Stellar cannot be offered as a swap source or cross-chain destination', () => {
  expect(getSwapInputTokens(202)).toEqual([]);
  expect(getSwapOutputTokens(202)).toEqual([]);
  for (const other of [1, 11155111]) {
    expect(crossChainSwapDepositSupported(other, 202)).toBe(false);
    expect(crossChainSwapDepositSupported(202, other)).toBe(false);
    expect(crossChainReshieldSupported(other, 202)).toBe(false);
    expect(crossChainReshieldSupported(202, other)).toBe(false);
  }
});
