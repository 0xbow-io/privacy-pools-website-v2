/**
 * `?env=staging-mainnet`: the staging world WITH its whitelisted pools
 * (Ethereum, Citrea, OP, BSC, Base) on the public production hosts too.
 *
 * PURE leaf module (no imports) so config/staging-deployments.ts, itself a
 * deliberate leaf, can read it without a new config edge.
 *
 * Plain `?env=staging` on v2.privacypools.com switches to the dev ASP world but
 * keeps the production-host backstop in config/staging-deployments.ts, which
 * drops every staging pool and leaves Sepolia, Sui and Stellar. This value lifts
 * that backstop for the tester who asks for it by URL. It is not an entry in
 * APP_ENVIRONMENTS, so no menu offers it: config/app-environment.ts reads it as
 * `staging`, and this module remembers the extra bit.
 *
 * Remembered like `?env=` (the query is gone after SPA navigation and reloads).
 * Any other `?env=` value forgets it. `EXPO_PUBLIC_STAGING_MAINNET=true` is the
 * build default for a deployment (and the unit suite, tests/bun-test-preload.ts);
 * unset, plain staging hides these pools.
 */
export const STAGING_MAINNET_ENV_VALUE = 'staging-mainnet';
export const STAGING_MAINNET_STORAGE_KEY = 'ppv2_staging_mainnet_v1';

type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

export type StagingMainnetResolution = {
  /** Show the Ethereum, OP and Base staging pools. */
  on: boolean;
  /**
   * A tester asked for it (the query, or its remembered bit). Only this lifts the
   * production-host backstop; a build default never does.
   */
  explicit: boolean;
};

/**
 * Pure resolution. A present `env` query (even empty) decides and is remembered:
 * `staging-mainnet` turns it on, anything else forgets it. With no query, the
 * remembered bit, then the build default.
 */
export function resolveStagingMainnetSource(deps: { search?: string | null; storage?: StorageLike | null; buildDefault?: string | null }): StagingMainnetResolution {
  let query: string | null = null;
  try {
    query = deps.search ? new URLSearchParams(deps.search).get('env') : null;
  } catch {
    query = null;
  }
  if (query !== null) {
    const on = query.trim().toLowerCase() === STAGING_MAINNET_ENV_VALUE;
    try {
      if (on) deps.storage?.setItem(STAGING_MAINNET_STORAGE_KEY, '1');
      else deps.storage?.removeItem(STAGING_MAINNET_STORAGE_KEY);
    } catch {
      // Storage refused: the query still decides this page load.
    }
    return { on, explicit: on };
  }
  let stored: string | null = null;
  try {
    stored = deps.storage?.getItem(STAGING_MAINNET_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  if (stored === '1') return { on: true, explicit: true };
  const build = deps.buildDefault?.trim().toLowerCase();
  return { on: build === 'true' || build === '1', explicit: false };
}

/** Whether the staging-mainnet pools show (any source). */
export function resolveStagingMainnet(deps: { search?: string | null; storage?: StorageLike | null; buildDefault?: string | null }): boolean {
  return resolveStagingMainnetSource(deps).on;
}

// Static member read: Metro only inlines static process.env.EXPO_PUBLIC_* access.
const BUILD_DEFAULT = process.env.EXPO_PUBLIC_STAGING_MAINNET;

function readStagingMainnet(): StagingMainnetResolution {
  if (typeof window === 'undefined') return resolveStagingMainnetSource({ buildDefault: BUILD_DEFAULT });
  let search: string | null = null;
  let storage: StorageLike | null = null;
  try { search = window.location?.search ?? null; } catch { search = null; }
  try { storage = window.localStorage ?? null; } catch { storage = null; }
  return resolveStagingMainnetSource({ search, storage, buildDefault: BUILD_DEFAULT });
}

const RESOLVED = readStagingMainnet();

/** Resolved once at module load, like the environment itself. */
export const STAGING_MAINNET_OPT_IN: boolean = RESOLVED.on;
/** A tester opted in by URL (now or remembered): the only thing that lifts the production-host backstop. */
export const STAGING_MAINNET_EXPLICIT: boolean = RESOLVED.explicit;
