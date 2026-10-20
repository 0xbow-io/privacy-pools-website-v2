import { describe, expect, test } from 'bun:test';

import {
  describeRelayedRegistrationBlocker,
  keystoreSupportsSignedRegistration,
  relayedRegistrationDeadline,
  RELAYED_REGISTRATION_TTL_SECONDS,
  relayerServesRegisterAndWithdraw,
  resolveRelayedRegistrationSupport,
  sdkSupportsRelayedRegistration,
} from '@/services/relayed-registration';
import type { Address, Hex } from '@/services/sdk-types';

const KEYSTORE = '0x6d264acb9c3a7a3105c29470afe2f5f1ec203c73' as Address;

const fullSession = {
  prepareRelayedRegistration: async () => ({
    account: KEYSTORE,
    nullifyingKeyHash: '0x1' as Hex,
    authDigest: '0x2' as Hex,
    deadline: '0x3' as Hex,
    signature: '0x4' as Hex,
  }),
  prepareRegisterAndWithdrawRelay: async () => ({}),
};

/** A fetch stub that answers one status for the register route. */
const fetchWith = (status: number) => (async () => ({ status } as Response)) as unknown as typeof fetch;

describe('sdkSupportsRelayedRegistration', () => {
  // Presence, not version: we have been handed vendored builds whose version
  // string said nothing about which methods survived a merge.
  test('requires BOTH methods', () => {
    expect(sdkSupportsRelayedRegistration(fullSession)).toBe(true);
    expect(sdkSupportsRelayedRegistration({ prepareRelayedRegistration: fullSession.prepareRelayedRegistration })).toBe(false);
    expect(sdkSupportsRelayedRegistration({ prepareRegisterAndWithdrawRelay: async () => ({}) })).toBe(false);
  });

  test('tolerates null/undefined sessions', () => {
    expect(sdkSupportsRelayedRegistration(null)).toBe(false);
    expect(sdkSupportsRelayedRegistration(undefined)).toBe(false);
    expect(sdkSupportsRelayedRegistration({})).toBe(false);
  });
});

describe('keystoreSupportsSignedRegistration', () => {
  // This is the probe that catches the real Sepolia state: the proxy answers
  // currentRoot() but reverts eip712Domain(), i.e. a pre-upgrade implementation
  // with no setAuthPolicyWithSig.
  test('true when eip712Domain() answers', async () => {
    expect(await keystoreSupportsSignedRegistration(async () => '0x', KEYSTORE)).toBe(true);
  });

  test('false when it reverts', async () => {
    expect(await keystoreSupportsSignedRegistration(async () => { throw new Error('execution reverted'); }, KEYSTORE))
      .toBe(false);
  });

  test('sends the eip712Domain() selector to the keystore', async () => {
    let seen: { to: string; data: string } | null = null;
    await keystoreSupportsSignedRegistration(async (p) => { seen = p as typeof seen; return '0x'; }, KEYSTORE);
    expect(seen).toEqual({ to: KEYSTORE, data: '0x84b0196e' });
  });
});

describe('relayerServesRegisterAndWithdraw', () => {
  // 404 = no route. A 4xx that isn't 404 = the route exists and rejected our
  // deliberately-empty body, which is the positive signal.
  test('404 means the route is absent', async () => {
    expect(await relayerServesRegisterAndWithdraw('https://r', 'evm', 1, fetchWith(404))).toBe(false);
  });

  test('400 means the route exists and validated', async () => {
    expect(await relayerServesRegisterAndWithdraw('https://r', 'evm', 1, fetchWith(400))).toBe(true);
  });

  // A 5xx or a network error is NOT evidence of support — guessing "probably
  // fine" costs a reverted on-chain transaction.
  test('5xx and transport failures are treated as unsupported', async () => {
    expect(await relayerServesRegisterAndWithdraw('https://r', 'evm', 1, fetchWith(500))).toBe(false);
    const boom = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
    expect(await relayerServesRegisterAndWithdraw('https://r', 'evm', 1, boom)).toBe(false);
  });

  test('targets the register-and-withdrawal path for the given chain', async () => {
    let url = '';
    const spy = (async (u: string) => { url = u; return { status: 400 } as Response; }) as unknown as typeof fetch;
    await relayerServesRegisterAndWithdraw('https://r', 'evm', 11155111, spy);
    expect(url).toBe('https://r/v1/relay/evm/11155111/register-and-withdrawal');
  });
});

describe('resolveRelayedRegistrationSupport', () => {
  const base = {
    keystoreAddress: KEYSTORE,
    relayerBaseUrl: 'https://r',
    chainType: 'evm',
    chainId: 11155111,
  };

  test('all three green => supported', async () => {
    const support = await resolveRelayedRegistrationSupport({
      ...base,
      session: fullSession,
      call: async () => '0x',
      fetchImpl: fetchWith(400),
    });
    expect(support).toEqual({ supported: true });
  });

  // Order matters: report the CHEAPEST, most-local blocker first so the reason
  // shown is the one an engineer can act on, not a downstream symptom.
  test('reports the SDK gap before making any network call', async () => {
    let called = false;
    const support = await resolveRelayedRegistrationSupport({
      ...base,
      session: {},
      call: async () => { called = true; return '0x'; },
      fetchImpl: fetchWith(400),
    });
    expect(support.supported).toBe(false);
    expect(support.supported === false && support.blocker).toBe('sdk-missing');
    expect(called).toBe(false);
  });

  test('reports the un-upgraded keystore before probing the relayer', async () => {
    let probed = false;
    const spy = (async () => { probed = true; return { status: 400 } as Response; }) as unknown as typeof fetch;
    const support = await resolveRelayedRegistrationSupport({
      ...base,
      session: fullSession,
      call: async () => { throw new Error('execution reverted'); },
      fetchImpl: spy,
    });
    expect(support.supported === false && support.blocker).toBe('keystore-not-upgraded');
    expect(probed).toBe(false);
  });

  // This is today's real Sepolia + staging state.
  test('reports the missing relayer route when the contract is fine', async () => {
    const support = await resolveRelayedRegistrationSupport({
      ...base,
      session: fullSession,
      call: async () => '0x',
      fetchImpl: fetchWith(404),
    });
    expect(support.supported === false && support.blocker).toBe('relayer-route-missing');
  });

  test('every blocker has user-facing copy, and support has none', async () => {
    for (const blocker of ['sdk-missing', 'keystore-not-upgraded', 'relayer-route-missing'] as const) {
      const text = describeRelayedRegistrationBlocker({ supported: false, blocker, detail: 'x' });
      expect(typeof text).toBe('string');
      expect((text ?? '').length).toBeGreaterThan(10);
    }
    expect(describeRelayedRegistrationBlocker({ supported: true })).toBeNull();
  });
});

describe('relayedRegistrationDeadline', () => {
  test('is hex unix-seconds in the future', () => {
    const now = 1_800_000_000_000;
    const d = relayedRegistrationDeadline(now);
    expect(d.startsWith('0x')).toBe(true);
    expect(Number(BigInt(d))).toBe(Math.floor(now / 1000) + RELAYED_REGISTRATION_TTL_SECONDS);
  });

  // The signature is taken BEFORE proving, which can run tens of seconds on a
  // slow device — a short TTL would expire on the user's own proof.
  test('defaults to a TTL that comfortably outlasts proving', () => {
    expect(RELAYED_REGISTRATION_TTL_SECONDS).toBeGreaterThanOrEqual(10 * 60);
  });

  test('honours an explicit TTL', () => {
    const now = 1_800_000_000_000;
    expect(Number(BigInt(relayedRegistrationDeadline(now, 60)))).toBe(Math.floor(now / 1000) + 60);
  });
});
