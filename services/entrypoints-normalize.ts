/**
 * PURE (types only), so the e2e harness can share it with the app.
 *
 * Collapse the raw /global/public/entrypoints response — old chain-grouped
 * map OR new flat pools[] — into the canonical EntrypointsResponse so every
 * consumer sees pools[]. Legacy entries have no poolVault, so the per-pool
 * match in resolveConfiguredEntrypoint falls back to the chain's single
 * entry (correct for single-pool chains, which is all the old API serves).
 */
import type { EntrypointsResponse, PoolEntrypoint, RawEntrypointsResponse } from './api-types';

export function normalizeEntrypoints(raw: RawEntrypointsResponse): EntrypointsResponse {
  if (Array.isArray(raw.pools)) {
    return { pools: raw.pools, cacheTimestamp: raw.cacheTimestamp };
  }
  const pools: PoolEntrypoint[] = Object.entries(raw.chains ?? {}).map(([key, cfg]) => ({
    poolId: key,
    chainId: String(cfg.chainId ?? key.replace(/^chain_/, '')),
    entrypoint: cfg.entrypoint,
    fromBlock: cfg.fromBlock,
  }));
  return { pools, cacheTimestamp: raw.cacheTimestamp };
}
