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

/** The relayer's asset list for `chainId`, or null when it cannot be read (fail closed upstream). */
export async function fetchRelayerAssetAddresses(chainId: number, timeoutMs = 8_000): Promise<Set<string> | null> {
  try {
    const { getChainConfig } = await import('@/config/chains');
    const url = getChainConfig(chainId)?.relayerBaseUrl;
    if (!url) return null;
    const res = await policedFetch('relayer', url, `${url.replace(/\/+$/, '')}/v1/details`, {
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(timeoutMs) : undefined,
    });
    if (!res.ok) return null;
    return parseRelayerAssetAddresses(await res.json(), chainId);
  } catch {
    return null;
  }
}

/** Copy for a REFUSED yield deposit, by verdict. Only a problem gets words: the
 *  in-flight first read shows nothing (Pat, 2026-09-04). */
export function relayerShareExitMessage(verdict: Exclude<RelayerAssetSupport, 'supported'>, underlyingSymbol: string, _shareSymbol?: string): string {
  if (verdict === 'unsupported') return `${underlyingSymbol} deposits open once the relayer supports withdrawing this pool. Not yet.`;
  return `Cannot confirm that the relayer supports withdrawing this pool right now. Try again in a moment.`;
}
