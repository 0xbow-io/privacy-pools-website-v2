import { describe, expect, mock, test } from 'bun:test';

mock.module('react-native', () => ({
  Platform: { OS: 'web', select: (o: Record<string, unknown>) => o.web ?? o.default },
}));

// config/chains builds its chain map at import, minus EXPO_PUBLIC_DISABLED_CHAIN_IDS;
// keep BNB in it so the BscScan assertions don't depend on the runner's env.
const disabledChainIds = process.env.EXPO_PUBLIC_DISABLED_CHAIN_IDS;
if (disabledChainIds) {
  process.env.EXPO_PUBLIC_DISABLED_CHAIN_IDS = disabledChainIds
    .split(',')
    .filter((id) => Number(id.trim()) !== 56)
    .join(',');
}

const { getExplorerName, getExplorerTxUrl, getExplorerAddressUrl } = await import('@/config/chains');
if (disabledChainIds) process.env.EXPO_PUBLIC_DISABLED_CHAIN_IDS = disabledChainIds;

describe('getExplorerName / explorer URLs are chain-specific', () => {
  test('BNB Chain names BscScan and links to bscscan.com', () => {
    expect(getExplorerName(56)).toBe('BscScan');
    expect(getExplorerTxUrl(56, '0xabc')).toBe('https://bscscan.com/tx/0xabc');
    expect(getExplorerAddressUrl(56, '0xdef')).toBe('https://bscscan.com/address/0xdef');
  });

  test('Sepolia still names Etherscan', () => {
    expect(getExplorerName(11155111)).toBe('Etherscan');
    expect(getExplorerTxUrl(11155111, '0xabc')).toBe('https://sepolia.etherscan.io/tx/0xabc');
  });

  test('a chain outside the active deployments is not labelled Etherscan', () => {
    expect(getExplorerName(4114)).toBe('Citrea Explorer');
    expect(getExplorerName(999_999)).toBe('Explorer');
  });
});
