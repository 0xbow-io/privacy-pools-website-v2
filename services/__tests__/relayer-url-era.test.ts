import { describe, expect, test } from 'bun:test';
import { resolveSepoliaRelayerBaseUrl } from '@/config/relayer-eras';

const STAGING = 'https://relayer-staging.example';
const TESTING = 'https://relayer-testing.example';
const V8_VAULT = '0x4DECEef285a24CA05999870887C895042731D7cB';

describe('resolveSepoliaRelayerBaseUrl (per-pool-era relayer routing)', () => {
  // The current era MUST stay on staging: it is the only instance whose
  // on-chain caller matches this pool's relay. Moving it to testing on
  // 2026-08-23 (to fix a genuine CORS problem) made a real relayed withdrawal
  // revert with PoolVault_ProofContextMismatch, because testing posts Sepolia
  // from the V8 relay. See config/relayer-eras.ts for the full account.
  test('default pool (no selection) → the staging relayer, the one bound to this pool', () => {
    expect(resolveSepoliaRelayerBaseUrl(undefined, undefined)).toBe(STAGING);
  });

  test('pre-cutover V8 vault → its own testing instance, case-insensitive', () => {
    expect(resolveSepoliaRelayerBaseUrl(V8_VAULT, undefined)).toBe(TESTING);
    expect(resolveSepoliaRelayerBaseUrl(V8_VAULT.toLowerCase(), undefined)).toBe(TESTING);
  });

  test('unmapped vault falls back to the current relayer (never empty)', () => {
    expect(resolveSepoliaRelayerBaseUrl('0x' + '9'.repeat(40), undefined)).toBe(STAGING);
  });

  test('env override wins over the era map; blank override is ignored', () => {
    expect(resolveSepoliaRelayerBaseUrl(V8_VAULT, 'https://example.test')).toBe('https://example.test');
    expect(resolveSepoliaRelayerBaseUrl(V8_VAULT, '   ')).toBe(TESTING);
    expect(resolveSepoliaRelayerBaseUrl(undefined, '')).toBe(STAGING);
  });

  // The guard now points the other way, and for a harder reason than CORS: the
  // testing instance serves the V8 pool, so pointing the CURRENT era at it makes
  // every relayed spend revert with PoolVault_ProofContextMismatch. Verified the
  // hard way on 2026-08-23.
  test('the current era must NOT be routed to the testing instance', () => {
    expect(resolveSepoliaRelayerBaseUrl(undefined, undefined)).not.toBe(TESTING);
    expect(resolveSepoliaRelayerBaseUrl('0x' + '9'.repeat(40), undefined)).not.toBe(TESTING);
  });
});
