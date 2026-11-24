import { describe, expect, test } from 'bun:test';
import { CURRENT_RELAY, RELAY_PROCESSOR_BY_VAULT, relaySupportsBatchWithdrawals, resolveSepoliaRelayerBaseUrl } from '@/config/relayer-eras';
import { SEPOLIA_DEFAULT_POOL } from '@/config/sepolia-deployment';

const STAGING = 'https://relayer-v2-staging-149184580131.us-east1.run.app';
const TESTING = 'https://relayer-v2-testing-149184580131.us-east1.run.app';
const V8_VAULT = '0x4DECEef285a24CA05999870887C895042731D7cB';
const V9_VAULT = '0x09b94d3127019298757a6ceeb7911922085f7c01';

describe('Sepolia pool and relayer routing', () => {
  test('default pool and withdrawal processor match the live V8 testing service', () => {
    expect(SEPOLIA_DEFAULT_POOL.pool).toBe(V8_VAULT.toLowerCase());
    expect(CURRENT_RELAY).toBe('0x87a5BFbAd7cA6B1FF3d9E631877B5930f17C24B0');
    expect(resolveSepoliaRelayerBaseUrl(undefined, undefined)).toBe(TESTING);
    expect(resolveSepoliaRelayerBaseUrl(SEPOLIA_DEFAULT_POOL.pool, undefined)).toBe(TESTING);
  });

  test('V8 selection is case-insensitive', () => {
    expect(resolveSepoliaRelayerBaseUrl(V8_VAULT, undefined)).toBe(TESTING);
    expect(resolveSepoliaRelayerBaseUrl(V8_VAULT.toLowerCase(), undefined)).toBe(TESTING);
  });

  test('explicit V9 selection retains its own relay and service', () => {
    expect(resolveSepoliaRelayerBaseUrl(V9_VAULT, undefined)).toBe(STAGING);
    expect(RELAY_PROCESSOR_BY_VAULT[V9_VAULT].relay).toBe('0x7430cc030d7eb8C83E76cD983996982C8C054204');
  });

  test('batch withdrawals require a capable relay on Sepolia', () => {
    expect(relaySupportsBatchWithdrawals(11155111, V8_VAULT)).toBe(false);
    expect(relaySupportsBatchWithdrawals(11155111)).toBe(false);
    expect(relaySupportsBatchWithdrawals(11155111, V9_VAULT.toUpperCase())).toBe(true);
    expect(relaySupportsBatchWithdrawals(1, V8_VAULT)).toBe(true);
  });

  test('unmapped vault falls back to the current relayer', () => {
    expect(resolveSepoliaRelayerBaseUrl('0x' + '9'.repeat(40), undefined)).toBe(TESTING);
  });

  test('env override wins; blank override is ignored', () => {
    expect(resolveSepoliaRelayerBaseUrl(V8_VAULT, 'https://example.test')).toBe('https://example.test');
    expect(resolveSepoliaRelayerBaseUrl(V8_VAULT, '   ')).toBe(TESTING);
    expect(resolveSepoliaRelayerBaseUrl(undefined, '')).toBe(TESTING);
  });
});
