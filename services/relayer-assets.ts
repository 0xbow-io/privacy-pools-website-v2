import { policedFetch } from '@/services/egress-fetch';
// Which assets the relayer will quote and relay on a chain, from its own
// `/v1/details`. A yield deposit mints a share note (ppUSDC) whose only exits,
// Withdraw and Send, go through the relayer: on 2026-09-04 the prod relayer
// answered "Asset 0xC246… not found for chain 1" for ppUSDC, so a deposit made
// that day would have been locked in until the relayer team finished their
// asset setup ("working on that"). The deposit therefore refuses, in words,
// while the relayer does not list the share, and opens by itself when it does.
// Asset-level read of a public endpoint; nothing here names a note.

type RelayerDetailsLike = {
  chains?: Array<{ id?: number | string; assets?: Array<{ address?: string }> }>;
};

/** Pure: lowercase asset addresses the relayer lists for `chainId`. */
export function parseRelayerAssetAddresses(details: unknown, chainId: number): Set<string> {
  const out = new Set<string>();
  const chains = (details as RelayerDetailsLike | null)?.chains;
  if (!Array.isArray(chains)) return out;
  for (const chain of chains) {
    if (Number(chain?.id) !== chainId) continue;
    for (const asset of chain.assets ?? []) {
      if (typeof asset?.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(asset.address)) out.add(asset.address.toLowerCase());
    }
  }
  return out;
}

export type RelayerAssetSupport = 'supported' | 'unsupported' | 'unknown';

/** Pure: the verdict for one asset given the relayer's list (or a failed read). */
export function relayerAssetSupport(listed: Set<string> | null, tokenAddress: string | undefined): RelayerAssetSupport {
  if (!listed || !tokenAddress) return 'unknown';
  return listed.has(tokenAddress.toLowerCase()) ? 'supported' : 'unsupported';
}

/**
 * A read of `/v1/details` that failed: the relayer answered with an error
 * status (a 429 from its throttler, most often) or did not answer at all.
 * `retryAfterMs` is the wait the relayer asked for, when a header says so.
 */
export class RelayerReadError extends Error {
  constructor(readonly status: number | null, readonly retryAfterMs: number | null) {
    super(status === null ? 'relayer details unreachable' : `relayer details answered ${status}`);
    this.name = 'RelayerReadError';
  }
}

/**
 * Pure: the wait in ms a response asks for, from `Retry-After` or any
 * `Retry-After-<bucket>` header (the prod relayer sends `retry-after-relay`
 * with its 429s). Seconds only; the longest one wins. Null when none is
 * readable, which includes a header the browser hides because CORS does not
 * expose it.
 */
export function relayerRetryAfterMs(headers: Pick<Headers, 'forEach'> | null | undefined): number | null {
  let best: number | null = null;
  headers?.forEach((value, name) => {
    if (!/^retry-after(-[a-z0-9_-]+)?$/i.test(name)) return;
    const seconds = Number(value.trim());
    if (Number.isFinite(seconds) && seconds >= 0) best = Math.max(best ?? 0, seconds * 1000);
  });
  return best;
}

/** Retries after a failed read before the deposit says it cannot check. */
export const RELAYER_READ_RETRIES = 4;
const RETRY_CAP_MS = 60_000;

/**
 * Pure: how long to wait before retry `attempt` (0-based). The relayer's own
 * Retry-After when it sent one, else 2 s, 4 s, 8 s, 16 s. Capped at a minute.
 * A throttled read used to fail at once and the deposit refused for five
 * minutes (Pat on a VPN exit, 2026-11-02, whose per-IP budget other users had
 * spent).
 */
export function relayerRetryDelayMs(attempt: number, error: unknown): number {
  const asked = error instanceof RelayerReadError ? error.retryAfterMs : null;
  return Math.min(asked ?? 2_000 * 2 ** attempt, RETRY_CAP_MS);
}

// The last list each chain's relayer returned. Which assets a relayer supports
// changes on a deploy, not between two reads, so a recent good answer stands in
// for a throttled one instead of refusing the deposit.
const LAST_GOOD_MS = 10 * 60_000;
const lastGood = new Map<number, { at: number; assets: Set<string> }>();

/** Remember a good read of `chainId`'s list (exported for tests). */
export function rememberRelayerAssets(chainId: number, assets: Set<string>, now = Date.now()): void {
  lastGood.set(chainId, { at: now, assets });
}

/** The list from a good read of `chainId` in the last ten minutes, if any. */
export function recentRelayerAssets(chainId: number, now = Date.now()): Set<string> | null {
  const hit = lastGood.get(chainId);
  return hit && now - hit.at <= LAST_GOOD_MS ? hit.assets : null;
}

/**
 * The relayer's asset list for `chainId`, null when the chain has no relayer.
 * Throws RelayerReadError when the read fails and no recent good list exists,
 * so a caller that retries (the deposit's query) can.
 */
export async function fetchRelayerAssetAddressesOrThrow(chainId: number, timeoutMs = 8_000): Promise<Set<string> | null> {
  const { getChainConfig } = await import('@/config/chains');
  const url = getChainConfig(chainId)?.relayerBaseUrl;
  if (!url) return null;
  let res: Response;
  try {
    res = await policedFetch('relayer', url, `${url.replace(/\/+$/, '')}/v1/details`, {
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined,
    });
  } catch {
    const recent = recentRelayerAssets(chainId);
    if (recent) return recent;
    throw new RelayerReadError(null, null);
  }
  if (!res.ok) {
    const recent = recentRelayerAssets(chainId);
    if (recent) return recent;
    throw new RelayerReadError(res.status, relayerRetryAfterMs(res.headers));
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // A 200 whose body is not JSON (a proxy page, a cut-off answer) is a failed read too.
    const recent = recentRelayerAssets(chainId);
    if (recent) return recent;
    throw new RelayerReadError(res.status, null);
  }
  const assets = parseRelayerAssetAddresses(body, chainId);
  rememberRelayerAssets(chainId, assets);
  return assets;
}

/** The relayer's asset list for `chainId`, or null when it cannot be read (fail closed upstream). */
export async function fetchRelayerAssetAddresses(chainId: number, timeoutMs = 8_000): Promise<Set<string> | null> {
  try {
    return await fetchRelayerAssetAddressesOrThrow(chainId, timeoutMs);
  } catch {
    return null;
  }
}

/** Copy for a REFUSED yield deposit, by verdict. Only a problem gets words: the
 *  in-flight first read shows nothing (Pat, 2026-09-04). This is a deposit, so
 *  the words are about the deposit, not about withdrawing (Pat, 2026-11-02). */
export function relayerShareExitMessage(verdict: Exclude<RelayerAssetSupport, 'supported'>, underlyingSymbol: string, _shareSymbol?: string): string {
  if (verdict === 'unsupported') return `${underlyingSymbol} deposits are not open on this network yet.`;
  return `Could not reach the relayer to check ${underlyingSymbol} deposits. Try again in a minute.`;
}

/**
 * The relayer's asset list could not be read, so a yield deposit was refused.
 * Typed so a failure report can say "relayer-unavailable" from the class
 * alone (services/error-reports-failure.ts), without reading this message.
 */
export class RelayerUnavailableError extends Error {
  readonly errorReportReason = 'relayer-unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'RelayerUnavailableError';
  }
}
