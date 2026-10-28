// Puts the SDK's direct-Across router in front of the LiFi provider, when the
// build asks for it and the vendored SDK has it.
//
// Pure and SDK-agnostic on purpose: the SDK module is passed in, so this runs in
// bun tests with fakes and stays inert against an SDK build that predates
// AcrossBridgeQuoteProvider (v2-monorepo#514). Until that SDK is vendored, the
// flag changes nothing. Browser routing also stays closed until a privacy-safe
// quote transport exists; re-vendoring alone must not activate network egress.

import { acrossDirectEnabled, acrossDirectSourceChainIds } from '@/config/across-direct';

/** The provider surface the session takes, as far as this module needs it. */
export interface QuoteProviderLike {
  getSwapQuote: (...args: never[]) => Promise<unknown>;
  getSwapAndDepositQuote: (...args: never[]) => Promise<unknown>;
  getSwapStatus: (...args: never[]) => Promise<unknown>;
}

type ProviderCtor = new (config: Record<string, unknown>, deps?: Record<string, unknown>) => QuoteProviderLike;

/** What this module reads off the SDK module, when present. */
export interface AcrossSdkExports {
  AcrossBridgeQuoteProvider?: ProviderCtor;
  PreferAcrossSwapQuoteProvider?: ProviderCtor;
}

export type AcrossWiring =
  | { kind: 'lifi-only'; reason: 'flag-off' | 'no-source-chains' | 'sdk-without-across' | 'privacy-transport-unavailable' }
  | { kind: 'across-first'; sourceChainIds: number[] };

/** What withAcrossDirect will do, without building anything. */
export function acrossWiring(sdk: AcrossSdkExports): AcrossWiring {
  if (!acrossDirectEnabled()) return { kind: 'lifi-only', reason: 'flag-off' };
  const sourceChainIds = acrossDirectSourceChainIds();
  if (sourceChainIds.length === 0) return { kind: 'lifi-only', reason: 'no-source-chains' };
  if (typeof sdk.AcrossBridgeQuoteProvider !== 'function' || typeof sdk.PreferAcrossSwapQuoteProvider !== 'function') {
    return { kind: 'lifi-only', reason: 'sdk-without-across' };
  }
  // The SDK sends the actual note-bearing destination message to suggested-fees.
  // Even plain quotes disclose action timing. Do not enable this from env vars
  // until a reviewed transport supplies quotes from a clock-driven public cache.
  return { kind: 'lifi-only', reason: 'privacy-transport-unavailable' };
}

/**
 * The provider to give the session. Currently returns `lifi` unchanged: browser
 * Across quoting is closed pending a reviewed privacy-safe transport. The wiring
 * below is retained for that integration, not enabled by environment variables.
 */
export function withAcrossDirect<T extends QuoteProviderLike>(
  lifi: T,
  sdk: AcrossSdkExports,
  fetchFn?: typeof fetch,
): T | QuoteProviderLike {
  const wiring = acrossWiring(sdk);
  if (wiring.kind !== 'across-first') return lifi;
  const across = new sdk.AcrossBridgeQuoteProvider!({}, fetchFn ? { fetch: fetchFn } : undefined);
  return new sdk.PreferAcrossSwapQuoteProvider!({
    across,
    fallback: lifi,
    sourceChainIds: wiring.sourceChainIds,
  });
}
