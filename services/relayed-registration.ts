/**
 * Relayed keystore registration — "register-and-withdraw".
 *
 * WHAT IT BUYS: a user who has never registered can withdraw a note without
 * ever sending (or paying for) a registration transaction. They sign an EIP-712
 * authorization off-chain; the relayer submits `PrivacyPoolRelay.registerAndRelay`,
 * which calls `Keystore.setAuthPolicyWithSig` and relays the withdrawal in ONE
 * transaction, and the registration gas is folded into the withdrawal fee. That
 * is the whole reason the bundle exists: a registration on its own has no fee to
 * pay for it, which is why the standalone endpoint is deferred (INTL-05) and the
 * SDK's `submitRelayedRegistration` throws.
 *
 * WHY IT IS GATED THREE WAYS. As of 2026-08-11 none of our deployments can run
 * this end to end, and each layer fails differently and late:
 *
 *   1. CONTRACT. `setAuthPolicyWithSig` exists only on the `v2.0` lineage, not
 *      on the monorepo mainline. More to the point, the Keystore proxy deployed
 *      on Sepolia does NOT have it: `eip712Domain()` reverts there while
 *      `currentRoot()` answers, so the proxy still points at a pre-EIP-712
 *      implementation. Submitting anyway burns a relayer transaction that
 *      reverts.
 *   2. RELAYER. The staging relayer ppv2 uses returns 404 for
 *      `/v1/relay/evm/{chainId}/register-and-withdrawal` (its `/withdrawal`
 *      route answers 400 on a bad body, so the 404 is a missing route, not a
 *      bad request). The testing relayer DOES serve it.
 *   3. SDK. The vendored bundle must expose `prepareRelayedRegistration` and
 *      `prepareRegisterAndWithdrawRelay`; older bundles do not.
 *
 * So `resolveRelayedRegistrationSupport` probes all three and returns a reason
 * when unavailable. Callers must treat "unsupported" as "use the ordinary
 * register-then-withdraw path", never as "try it and see".
 */

import type { Address, Hex } from '@/services/sdk-types';

/** Why the relayed path is unavailable, in the caller's words. */
export type RelayedRegistrationBlocker =
  | 'sdk-missing'
  | 'keystore-not-upgraded'
  | 'relayer-route-missing';

export type RelayedRegistrationSupport =
  | { supported: true }
  | { supported: false; blocker: RelayedRegistrationBlocker; detail: string };

/** `eip712Domain()` — present iff the Keystore implementation carries EIP-712. */
const EIP712_DOMAIN_SELECTOR = '0x84b0196e';

/**
 * The session methods this flow needs. Structural, like the rest of
 * services/sdk-types.ts, so nothing here imports the SDK at runtime.
 */
export interface RelayedRegistrationSessionLike {
  prepareRelayedRegistration?: (options: { deadline: Hex; sign?: boolean }) => Promise<{
    account: Address;
    nullifyingKeyHash: Hex;
    authDigest: Hex;
    deadline: Hex;
    signature: Hex | null;
  }>;
  prepareRegisterAndWithdrawRelay?: (params: unknown, registration: unknown) => Promise<unknown>;
}

/**
 * Does the SDK bundle expose the relayed-registration API at all?
 *
 * Checked by presence rather than by version string: the app has been vendored
 * builds whose version told you nothing about which methods survived a merge.
 */
export function sdkSupportsRelayedRegistration(session: unknown): boolean {
  const s = session as RelayedRegistrationSessionLike | null | undefined;
  return typeof s?.prepareRelayedRegistration === 'function'
    && typeof s?.prepareRegisterAndWithdrawRelay === 'function';
}

/**
 * Is the DEPLOYED Keystore the EIP-712 implementation that has
 * `setAuthPolicyWithSig`?
 *
 * Probed via `eip712Domain()`, which the OpenZeppelin EIP712Upgradeable base
 * adds and the pre-upgrade implementation lacks. A revert is the negative
 * signal; a transport failure is NOT — those are reported as unknown by the
 * caller rather than silently enabling or disabling the flow.
 */
export async function keystoreSupportsSignedRegistration(
  call: (params: { to: Address; data: Hex }) => Promise<unknown>,
  keystoreAddress: Address,
): Promise<boolean> {
  try {
    await call({ to: keystoreAddress, data: EIP712_DOMAIN_SELECTOR as Hex });
    return true;
  } catch {
    return false;
  }
}

/**
 * Does the relayer route exist?
 *
 * A missing route 404s; a present route rejects a deliberately-empty body with
 * a 4xx that is NOT 404 (the relayer validates the schema). Anything else —
 * network error, 5xx — is treated as unavailable, because guessing "probably
 * fine" here costs a reverted on-chain transaction.
 */
export async function relayerServesRegisterAndWithdraw(
  relayerBaseUrl: string,
  chainType: string,
  chainId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(
      `${relayerBaseUrl}/v1/relay/${chainType}/${chainId}/register-and-withdrawal`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      },
    );
    // 404 = no such route. Any other 4xx = the route exists and rejected the
    // empty body, which is exactly what we want to see.
    return response.status !== 404 && response.status < 500;
  } catch {
    return false;
  }
}

/** Roll the three probes into one answer, with the reason preserved. */
export async function resolveRelayedRegistrationSupport(params: {
  session: unknown;
  keystoreAddress: Address;
  relayerBaseUrl: string;
  chainType: string;
  chainId: number;
  call: (p: { to: Address; data: Hex }) => Promise<unknown>;
  fetchImpl?: typeof fetch;
}): Promise<RelayedRegistrationSupport> {
  if (!sdkSupportsRelayedRegistration(params.session)) {
    return {
      supported: false,
      blocker: 'sdk-missing',
      detail: 'The vendored SDK build has no prepareRelayedRegistration / prepareRegisterAndWithdrawRelay.',
    };
  }
  if (!(await keystoreSupportsSignedRegistration(params.call, params.keystoreAddress))) {
    return {
      supported: false,
      blocker: 'keystore-not-upgraded',
      detail:
        `The Keystore at ${params.keystoreAddress} has no eip712Domain(), so its implementation predates `
        + 'setAuthPolicyWithSig. The proxy needs the v2.0 implementation and initializeEIP712().',
    };
  }
  if (!(await relayerServesRegisterAndWithdraw(
    params.relayerBaseUrl,
    params.chainType,
    params.chainId,
    params.fetchImpl,
  ))) {
    return {
      supported: false,
      blocker: 'relayer-route-missing',
      detail: `${params.relayerBaseUrl} does not serve /v1/relay/${params.chainType}/${params.chainId}/register-and-withdrawal.`,
    };
  }
  return { supported: true };
}

/** Default validity for the signed authorization. */
export const RELAYED_REGISTRATION_TTL_SECONDS = 30 * 60;

/**
 * Deadline for the EIP-712 authorization, as the contract wants it (0x hex
 * unix-seconds).
 *
 * Deliberately generous relative to a fee commitment: this signature is taken
 * BEFORE proof generation, and proving can run for tens of seconds on a slow
 * device. Too tight and the user signs, waits for their own proof, and is told
 * the authorization expired.
 */
export function relayedRegistrationDeadline(
  nowMs: number,
  ttlSeconds: number = RELAYED_REGISTRATION_TTL_SECONDS,
): Hex {
  const seconds = Math.floor(nowMs / 1000) + ttlSeconds;
  return `0x${seconds.toString(16)}` as Hex;
}

/** Human sentence for a blocker, for the UI and the debug log. */
export function describeRelayedRegistrationBlocker(support: RelayedRegistrationSupport): string | null {
  if (support.supported) return null;
  switch (support.blocker) {
    case 'sdk-missing':
      return 'Gasless registration needs a newer SDK build.';
    case 'keystore-not-upgraded':
      return 'Gasless registration is not available on this network yet. The keystore contract has not been upgraded for it.';
    case 'relayer-route-missing':
    default:
      return 'Gasless registration is not available on this network yet. The relayer does not offer it.';
  }
}
