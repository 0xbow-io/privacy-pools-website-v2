import { describe, expect, test } from 'bun:test';
import { parseRelayerAssetAddresses, relayerAssetSupport, relayerShareExitMessage } from '@/services/relayer-assets';

// Shape of the prod relayer's /v1/details on 2026-09-04 (trimmed).
const DETAILS = {
  version: '1.0.0',
  chains: [
    { id: 4114, name: 'citrea', type: 'evm', assets: [{ address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', ticker: 'CBTC' }] },
    { id: 1, name: 'ethereum', type: 'evm', assets: [{ address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', ticker: 'ETH' }, { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', ticker: 'USDC' }, { address: 'not-an-address' }] },
  ],
};
const PPUSDC = '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6';

describe('relayer asset support', () => {
  test('lists the chain\'s assets lowercased and ignores junk', () => {
    const one = parseRelayerAssetAddresses(DETAILS, 1);
    expect([...one].sort()).toEqual(['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee']);
    expect(parseRelayerAssetAddresses(DETAILS, 56).size).toBe(0);
    expect(parseRelayerAssetAddresses(null, 1).size).toBe(0);
    expect(parseRelayerAssetAddresses({ chains: 'nope' }, 1).size).toBe(0);
  });
  test('the share is unsupported until the relayer lists it; a failed read is unknown, never supported', () => {
    const one = parseRelayerAssetAddresses(DETAILS, 1);
    expect(relayerAssetSupport(one, PPUSDC)).toBe('unsupported');
    expect(relayerAssetSupport(one, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe('supported');
    expect(relayerAssetSupport(null, PPUSDC)).toBe('unknown');
    expect(relayerAssetSupport(one, undefined)).toBe('unknown');
  });
  test('copy names the underlying, never the share', () => {
    expect(relayerShareExitMessage('unsupported', 'USDC', 'ppUSDC')).toBe('USDC deposits open once the relayer supports withdrawing this pool. Not yet.');
    // Ameen via Pat, 2026-09-12: the share name never reaches a sentence.
    expect(relayerShareExitMessage('unsupported', 'USDC', 'ppUSDC')).not.toMatch(/\bpp(usdc|usdt)\b/i);
    expect(relayerShareExitMessage('unknown', 'USDC', 'ppUSDC')).not.toMatch(/\bpp(usdc|usdt)\b/i);
    // The in-flight first read gets no copy at all: only a refusal is worded.
    expect(relayerShareExitMessage('unknown', 'USDC', 'ppUSDC')).toContain('Cannot confirm');
  });
});
