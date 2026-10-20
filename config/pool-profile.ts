import { Platform } from 'react-native';

import { INTERNAL_TOOLS_ENABLED } from '@/config/internal-tools';

/**
 * Pool selection: lets one build serve ANY pool the ASP currently lists in
 * /global/public/entrypoints, so depositors on an older entrypoint can still
 * see and exit their funds without a separate build.
 *
 * The menu (header → Pool) fetches the pool list dynamically from the ASP;
 * what is persisted here is the picked pool's identity (vault + entrypoint +
 * fromBlock from the feed). Resolved ONCE at module load — config/env.ts and
 * config/relayer.ts bake the selected addresses into their exported
 * constants — so switching applies via a reload, the same pattern as the
 * design-variant switcher. No selection stored = the build's default
 * (current) pool. Native always uses the default.
 *
 * Data the feed does NOT carry (keystore address, relayer processor era) is
 * mapped per known vault in env.ts / relayer.ts with current-pool fallbacks.
 *
 * Caveat: the hosted relayer only serves the current pool, so relayed
 * withdrawals/transfers on an older pool may be declined — ragequit (direct
 * on-chain exit to the original depositor) always works.
 */

export type PoolSelection = {
  /** PoolVault address — the identity the app's config keys off. */
  poolVault: string;
  /** Entrypoint address (informational; runtime still resolves via the ASP). */
  entrypoint: string;
  /** Earliest deposit block from the feed — used as the scan floor. */
  fromBlock: number;
};

const POOL_SELECTION_STORAGE_KEY = 'ppv2_pool_selection_v1';
// First iteration of the switcher stored a named profile; retire it.
const OLD_PROFILE_STORAGE_KEY = 'ppv2_pool_profile';

function readStoredPoolSelection(): PoolSelection | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  try {
    window.localStorage.removeItem(OLD_PROFILE_STORAGE_KEY);
    // With internal tools off there is no UI to change this back, so honouring
    // a stored override would strand that browser on an alternate pool forever
    // (codex, High). It is not cosmetic state: it drives the pool address and
    // scan floors (config/env.ts), the relayer era and URL (config/relayer.ts)
    // and cache partitioning (components/sdk-provider.tsx). Clear it, so the
    // build the flag describes is the build you actually get.
    if (!INTERNAL_TOOLS_ENABLED) {
      window.localStorage.removeItem(POOL_SELECTION_STORAGE_KEY);
      return null;
    }
    const raw = window.localStorage.getItem(POOL_SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PoolSelection>;
    if (
      typeof parsed.poolVault === 'string' && /^0x[0-9a-fA-F]{40}$/.test(parsed.poolVault)
      && typeof parsed.entrypoint === 'string'
      && typeof parsed.fromBlock === 'number' && Number.isFinite(parsed.fromBlock)
    ) {
      return { poolVault: parsed.poolVault, entrypoint: parsed.entrypoint, fromBlock: parsed.fromBlock };
    }
  } catch {
    // Storage unavailable / corrupted — default pool.
  }
  return null;
}

/** Resolved once at module load; switching requires a reload (by design). */
export const ActivePoolSelection: PoolSelection | null = readStoredPoolSelection();

/** True when no override is stored — the build's default (current) pool. */
export const IsDefaultPoolActive = ActivePoolSelection === null;

/**
 * Persist a pool selection (null = back to the default pool) and reload to
 * re-bake the config constants.
 */
export function applyPoolSelection(selection: PoolSelection | null) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  // Inert while the tools are off: the flag gates the mechanism, not only the
  // row that used to call it.
  if (!INTERNAL_TOOLS_ENABLED) return;
  try {
    if (selection) {
      window.localStorage.setItem(POOL_SELECTION_STORAGE_KEY, JSON.stringify(selection));
    } else {
      window.localStorage.removeItem(POOL_SELECTION_STORAGE_KEY);
    }
  } catch {
    // Storage unavailable — the reload keeps the current pool.
  }
  window.location.reload();
}
