// The relayer's own statement of what it relays through, per chain:
// `GET {relayer}/v1/details/{chainType}/{chainId}` (SDK 4567778d,
// `RelayerChainDetailsSchema`). It names the Entrypoint / relay / RelaySwaps
// contracts, the `processors` a relayed contract call may target (the
// PPRouters on mainnet since 2026-09-18) and the yield wrappers
// (`yield[]`: ppToken / underlying / router / zap).
//
// Why the app reads it: every swap-shaped flow binds its proof and its LiFi
// quote to a processor address the app used to hard-code, and the relayer has
// redeployed that contract under the app twice (RelaySwaps moved to
// 0xd0395c08… on 2026-09-18 while the app still named the old one). Reading
// the relayer's list lets a swap refuse BEFORE a quote when the two disagree,
// instead of a proof that reverts with PoolVault_ProofContextMismatch.
//
// Privacy: the request names nothing about the user (a chain id only); the
// route is declared in services/egress-policy.ts.
import { z } from 'zod';
import type { RelayerChainDetails as SdkRelayerChainDetails } from '@privacy-pools-v2/sdk';
import { policedFetch } from '@/services/egress-fetch';
import { recordRelayerDestinationCalls } from '@/config/destination-calls';

// `destinationCallsSupported` (v2-monorepo#486) is newer than the vendored
// SDK's type, so the app's mirror adds it.
export type RelayerChainDetails = SdkRelayerChainDetails & { destinationCallsSupported?: boolean };

const CACHE_TTL_MS = 60_000;
// Keyed by chain AND relayer URL: an environment switch reloads the page today,
// but a cache that outlived a relayer change would certify the wrong contract.
const cache = new Map<string, { at: number; details: RelayerChainDetails | null }>();

// Mirrors the SDK's RelayerChainDetailsSchema (packages/sdk/src/schemas/
// RelayerInteractor.ts at 4567778d). The SDK declares that schema but its
// bundle does not export it at runtime, only the type, so the app validates
// with its own copy. Optional blocks stay optional: an older relayer publishes
// neither `relayerAddress` nor `processors` nor `yield`.
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const RelayerChainDetailsShape = z.object({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  contracts: z.object({
    entrypoint: Address,
    poolVault: Address,
    relay: Address,
    relaySwaps: Address.optional(),
  }),
  swapsSupported: z.boolean(),
  destinationCallsSupported: z.boolean().optional(),
  assets: z.array(z.object({
    address: Address,
    ticker: z.string(),
    fixedFeeAmount: z.union([z.string(), z.number()]).optional(),
    feeBPS: z.union([z.string(), z.number()]).optional(),
  })),
  relayerAddress: Address.optional(),
  processors: z.array(Address).optional(),
  yield: z.array(z.object({
    ppToken: Address,
    underlying: Address,
    router: Address,
    zap: Address,
    ppDecimals: z.number().int().nonnegative(),
    underlyingDecimals: z.number().int().nonnegative(),
    underlyingSymbol: z.string(),
  })).optional(),
});

/** Pure: parse a `/v1/details/{chainType}/{chainId}` body, or null when it is not one. */
export function parseRelayerChainDetails(body: unknown): RelayerChainDetails | null {
  const parsed = RelayerChainDetailsShape.safeParse(body);
  return parsed.success ? (parsed.data as unknown as RelayerChainDetails) : null;
}

/** Pure: lower-cased processor addresses the relayer will relay a contract call to. */
export function relayerProcessors(details: RelayerChainDetails | null): Set<string> {
  return new Set((details?.processors ?? []).map((a) => a.toLowerCase()));
}

/** Pure: the PPRouter the relayer publishes for a share token, if any. */
export function relayerYieldRouterFor(details: RelayerChainDetails | null, shareAddress: string): string | undefined {
  const hit = (details?.yield ?? []).find((w) => w.ppToken.toLowerCase() === shareAddress.toLowerCase());
  return hit?.router;
}

export type RelayerProcessorVerdict = 'matches' | 'differs' | 'unsupported' | 'unknown';

/**
 * Pure: does the RelaySwaps contract the app binds swaps to agree with the
 * relayer's? `differs` when both name one and they disagree; `unsupported`
 * when the relayer says it relays no swaps on the chain while the app has a
 * processor for it (the relayer's answer is a contradiction, not missing
 * data); `unknown` when nothing could be read or the app has no processor.
 * The caller refuses on the first two and proceeds as before on `unknown`.
 */
export function relayerSwapProcessorVerdict(details: RelayerChainDetails | null, configured: string | undefined): RelayerProcessorVerdict {
  if (!details || !configured) return 'unknown';
  if (!details.swapsSupported) return 'unsupported';
  const published = details.contracts.relaySwaps;
  if (!published) return 'unknown';
  return published.toLowerCase() === configured.toLowerCase() ? 'matches' : 'differs';
}

/** Copy for a swap refused because the relayer and the app name different swap contracts. */
export const SWAP_PROCESSOR_DRIFT_MESSAGE =
  'The relayer moved its swap contract and this app still names the old one. Swaps are paused until the app is updated. Nothing was sent.';

/** Copy for a swap refused because the relayer no longer relays swaps on this network. */
export const SWAP_UNSUPPORTED_MESSAGE =
  'The relayer does not relay swaps on this network right now. Nothing was sent.';

/**
 * The one check every swap-shaped flow runs before it binds a quote or a
 * proof to `configured`: throws with the user-facing reason on a
 * contradiction, returns quietly on a match or when the relayer could not be
 * read. Withdraw's "receive as", the swap modal and both confirm re-quotes
 * call it; a call site that only reads getSwapProcessorAddress is the bypass
 * the guard test in services/__tests__/relayer-details.test.ts looks for.
 */
export async function assertRelayerSwapProcessor(chainId: number, configured: string | undefined, deps?: RelayerDetailsDeps): Promise<void> {
  const verdict = relayerSwapProcessorVerdict(await fetchRelayerChainDetails(chainId, deps), configured);
  if (verdict === 'differs') throw new Error(SWAP_PROCESSOR_DRIFT_MESSAGE);
  if (verdict === 'unsupported') throw new Error(SWAP_UNSUPPORTED_MESSAGE);
}

/** What the fetch needs from the app; the tests hand in fakes, production the defaults below. */
export type RelayerDetailsDeps = {
  now: () => number;
  /** The relayer base URL and chain type for a chain, or undefined when the app has none. */
  relayerFor: (chainId: number) => Promise<{ url: string; chainType: string } | undefined>;
  /** The egress-policed GET; throws or returns a Response like fetch does. */
  get: (base: string, url: string, timeoutMs: number) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
};

const DEFAULT_DEPS: RelayerDetailsDeps = {
  now: () => Date.now(),
  relayerFor: async (chainId) => {
    const { getChainConfig } = await import('@/config/chains');
    const chain = getChainConfig(chainId);
    return chain?.relayerBaseUrl ? { url: chain.relayerBaseUrl, chainType: chain.chainType } : undefined;
  },
  get: (base, url, timeoutMs) => policedFetch('relayer', base, url, {
    signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined,
  }),
};

/**
 * The relayer's chain details, cached for a minute, or null when they cannot
 * be read (network, an older relayer without the route, a shape the schema
 * rejects, a body for another chain). Callers treat null as "unknown", never
 * as "fine"; a null is cached too, so an outage costs one request a minute.
 */
export async function fetchRelayerChainDetails(
  chainId: number,
  deps: RelayerDetailsDeps = DEFAULT_DEPS,
  timeoutMs = 8_000,
): Promise<RelayerChainDetails | null> {
  let details: RelayerChainDetails | null = null;
  let key = `${chainId}:`;
  try {
    const relayer = await deps.relayerFor(chainId);
    key = `${chainId}:${relayer?.url ?? ''}`;
    const hit = cache.get(key);
    if (hit && deps.now() - hit.at < CACHE_TTL_MS) return hit.details;
    if (relayer && relayer.chainType === 'evm') {
      const res = await deps.get(relayer.url, `${relayer.url.replace(/\/+$/, '')}/v1/details/evm/${chainId}`, timeoutMs);
      if (res.ok) {
        const parsed = parseRelayerChainDetails(await res.json());
        // A valid body for another chain cannot answer this chain's verdict.
        if (parsed?.id === chainId && parsed.type === 'evm') {
          details = parsed;
          // The gate in config/intent-swaps reads this; an absent field falls
          // back to the static table there.
          recordRelayerDestinationCalls(chainId, parsed.destinationCallsSupported);
        }
      }
    }
  } catch {
    details = null;
  }
  cache.set(key, { at: deps.now(), details });
  return details;
}

/** Tests only. */
export function resetRelayerChainDetailsCacheForTests(): void {
  cache.clear();
}
