import { describe, expect, test } from 'bun:test';
import {
  parseRelayerAssetAddresses,
  recentRelayerAssets,
  rememberRelayerAssets,
  RelayerReadError,
  relayerAssetSupport,
  relayerRetryAfterMs,
  relayerRetryDelayMs,
  relayerShareExitMessage,
} from '@/services/relayer-assets';

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
  test('copy names the underlying, never the share, and never talks about withdrawing', () => {
    expect(relayerShareExitMessage('unsupported', 'USDC', 'ppUSDC')).toBe('USDC deposits are not open on this network yet.');
    expect(relayerShareExitMessage('unknown', 'USDC', 'ppUSDC')).toBe('Could not reach the relayer to check USDC deposits. Try again in a minute.');
    for (const verdict of ['unsupported', 'unknown'] as const) {
      // Ameen via Pat, 2026-09-12: the share name never reaches a sentence.
      expect(relayerShareExitMessage(verdict, 'USDC', 'ppUSDC')).not.toMatch(/\bpp(usdc|usdt|eth)\b/i);
      // Pat, 2026-11-02: a shield that says "withdrawing" reads as the wrong flow.
      expect(relayerShareExitMessage(verdict, 'USDC', 'ppUSDC')).not.toMatch(/withdraw/i);
    }
  });
  test('a throttled read asks for the wait the relayer sent, else backs off, capped at a minute', () => {
    const headers = new Headers({ 'retry-after-relay': '54', 'x-ratelimit-reset-quote': '46' });
    expect(relayerRetryAfterMs(headers)).toBe(54_000);
    expect(relayerRetryAfterMs(new Headers({ 'Retry-After': '3', 'retry-after-relay': '20' }))).toBe(20_000);
    expect(relayerRetryAfterMs(new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }))).toBeNull();
    expect(relayerRetryAfterMs(new Headers())).toBeNull();
    expect(relayerRetryAfterMs(null)).toBeNull();
    expect(relayerRetryDelayMs(0, new RelayerReadError(429, 54_000))).toBe(54_000);
    expect(relayerRetryDelayMs(0, new RelayerReadError(429, 600_000))).toBe(60_000);
    expect([0, 1, 2].map((n) => relayerRetryDelayMs(n, new RelayerReadError(429, null)))).toEqual([10_000, 20_000, 30_000]);
    expect(relayerRetryDelayMs(1, new Error('other'))).toBe(20_000);
  });
  test('a recent good read stands in for a failed one, an old one does not', () => {
    const one = parseRelayerAssetAddresses(DETAILS, 1);
    rememberRelayerAssets(1, one, 1_000);
    expect(recentRelayerAssets(1, 1_000 + 9 * 60_000)).toBe(one);
    expect(recentRelayerAssets(1, 1_000 + 11 * 60_000)).toBeNull();
    expect(recentRelayerAssets(56, 1_000)).toBeNull();
  });
});
