/**
 * Prod vs Staging: which world the app talks to - PURE module (no
 * react-native imports; browser globals are only touched behind guards) so
 * bun tests can import it.
 *
 * The two environments are separate deployments end to end: ASP, relayer,
 * pools, tokens, chains. Sepolia and the whitelisted staging pools live on the
 * dev ASP; the production pools live on the prod ASP (Artem, 2026-09-02:
 * "Sepolia and staging pools are still on dev endpoint"). One app serves both,
 * one at a time.
 *
 * Resolution happens ONCE at module load and the whole config layer bakes the
 * result into its constants (config/environments.ts), so switching is a
 * persist-and-reload, the same pattern as the design-variant and pool
 * switchers. There is deliberately no hot swap: the SDK session, query caches
 * and providers all assume one world for the life of the page.
 *
 * Precedence: `?env=prod|staging` (one-shot tester override, persisted like
 * `?debug=1` so SPA navigation does not flip the world back) > the stored
 * choice > EXPO_PUBLIC_APP_ENV (a deployment's default) > prod.
 */
export type AppEnvironment = 'prod' | 'staging';

export const APP_ENVIRONMENTS: readonly AppEnvironment[] = ['prod', 'staging'];
export const DEFAULT_APP_ENVIRONMENT: AppEnvironment = 'prod';
export const APP_ENVIRONMENT_STORAGE_KEY = 'ppv2_app_env_v1';
export const APP_ENVIRONMENT_QUERY_PARAM = 'env';

/**
 * Hostnames that are staging and nothing else: the dev-branch test domain
 * (Vercel serves it from the `dev` branch). On these the world is not a
 * preference, so `?env=`, the stored choice and the build default are all
 * ignored and the environment switcher is hidden. Without this a tester on
 * test.privacypools.com could flip to prod with `?env=prod`.
 */
export const STAGING_ONLY_HOSTNAMES: readonly string[] = [
  'test.privacypools.com',
  'testnet.privacypools.com',
];

export function isStagingOnlyHostname(hostname: string | null | undefined): boolean {
  const host = hostname?.trim().toLowerCase();
  return !!host && STAGING_ONLY_HOSTNAMES.includes(host);
}

export function parseAppEnvironment(raw: string | null | undefined): AppEnvironment | undefined {
  const value = raw?.trim().toLowerCase();
  // `staging-mainnet` is the staging world plus its pools on the production
  // hosts (config/staging-mainnet.ts). Deliberately not in APP_ENVIRONMENTS,
  // so no menu lists it.
  if (value === 'staging-mainnet') return 'staging';
  return value === 'prod' || value === 'staging' ? value : undefined;
}

export function appEnvironmentLabel(env: AppEnvironment): string {
  return env === 'prod' ? 'Prod' : 'Staging';
}

/** Pure precedence: query > stored > build default > prod. Garbage at any level is skipped. */
export function resolveAppEnvironment(input: {
  query?: string | null;
  stored?: string | null;
  buildDefault?: string | null;
}): AppEnvironment {
  return parseAppEnvironment(input.query)
    ?? parseAppEnvironment(input.stored)
    ?? parseAppEnvironment(input.buildDefault)
    ?? DEFAULT_APP_ENVIRONMENT;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Resolve the environment from a URL search string and a storage - every
 * read and write wrapped, so a missing or throwing storage (private mode,
 * disabled site data) resolves to the default instead of taking the config
 * layer down at import time. A query override is persisted so the next
 * reload (which drops the query) lands in the same world.
 */
export function readAppEnvironment(deps: {
  search?: string | null;
  storage?: StorageLike | null;
  buildDefault?: string | null;
  /** The prod world serves Stellar too (EXPO_PUBLIC_STELLAR_ENABLED). */
  prodIncludesStellar?: boolean;
  /** window.location.hostname; a staging-only host short-circuits to staging. */
  hostname?: string | null;
}): AppEnvironment {
  // Staging-only host: no query, no stored choice, and nothing written back.
  if (isStagingOnlyHostname(deps.hostname)) return 'staging';
  let query: string | null = null;
  try {
    const params = deps.search ? new URLSearchParams(deps.search) : null;
    query = params?.get(APP_ENVIRONMENT_QUERY_PARAM) ?? null;
    // A ?stellar=true link is a link to the Stellar testnet, which lives in
    // the staging world unless prod serves it. Without this, a first visit (or
    // a browser last left on Prod) opens a world with no Stellar at all, and
    // Connect Wallet offers WalletConnect only.
    const stellar = params?.get('stellar');
    if (!parseAppEnvironment(query) && !deps.prodIncludesStellar && (stellar === 'true' || stellar === '1')) query = 'staging';
  } catch {
    query = null;
  }
  let stored: string | null = null;
  try {
    stored = deps.storage?.getItem(APP_ENVIRONMENT_STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  const env = resolveAppEnvironment({ query, stored, buildDefault: deps.buildDefault });
  if (parseAppEnvironment(query) && stored !== env) {
    try {
      deps.storage?.setItem(APP_ENVIRONMENT_STORAGE_KEY, env);
    } catch {
      // Storage refused the write; the query still decides this page load.
    }
  }
  return env;
}

// Static member read: Metro only inlines static process.env.EXPO_PUBLIC_*
// access in the production web export.
const BUILD_DEFAULT_APP_ENVIRONMENT = process.env.EXPO_PUBLIC_APP_ENV;

function readActiveAppEnvironment(): AppEnvironment {
  if (typeof window === 'undefined') {
    return resolveAppEnvironment({ buildDefault: BUILD_DEFAULT_APP_ENVIRONMENT });
  }
  let search: string | null = null;
  try {
    search = window.location?.search ?? null;
  } catch {
    search = null;
  }
  let storage: StorageLike | null = null;
  try {
    storage = window.localStorage ?? null;
  } catch {
    storage = null;
  }
  let hostname: string | null = null;
  try {
    hostname = window.location?.hostname ?? null;
  } catch {
    hostname = null;
  }
  return readAppEnvironment({
    search,
    storage,
    hostname,
    buildDefault: BUILD_DEFAULT_APP_ENVIRONMENT,
    // Static member read, for the same reason as above.
    prodIncludesStellar: process.env.EXPO_PUBLIC_STELLAR_ENABLED === 'true',
  });
}

/** Resolved once at module load; switching requires a reload (by design). */
export const ACTIVE_APP_ENVIRONMENT: AppEnvironment = readActiveAppEnvironment();

/** True on a host that only ever serves staging (the switcher is hidden there). */
export const IS_STAGING_ONLY_HOST: boolean =
  typeof window !== 'undefined' &&
  isStagingOnlyHostname(
    (() => {
      try {
        return window.location?.hostname ?? null;
      } catch {
        return null;
      }
    })(),
  );

export function getActiveAppEnvironment(): AppEnvironment {
  return ACTIVE_APP_ENVIRONMENT;
}

/**
 * Storage key scoped to an environment. Staging keeps today's bare keys so
 * nothing a staging tester has stored moves; prod gets a `_prod` suffix.
 * Underscore, not a colon: expo-secure-store rejects colons in keys and
 * several stores share their key between localStorage and SecureStore.
 *
 * Use it for every per-user record that is keyed by owner and/or chain alone.
 * Prod and staging deploy different pools on the SAME chain ids (1, 4114, 56),
 * so a chain-keyed record written in one world would otherwise be read in the
 * other - staging-pool notes loaded into a prod session, or a staging "Sent"
 * row shown against prod balances. Records already keyed by pool address or
 * keystore address separate on their own and need no suffix.
 */
export function envScopedStorageKey(base: string, env: AppEnvironment = ACTIVE_APP_ENVIRONMENT): string {
  return env === 'staging' ? base : `${base}_${env}`;
}

/**
 * The current page URL with `?env=<env>` set (replacing any stale value). Pure,
 * so the reload target can be tested; falls back to the input on a bad URL.
 */
export function withAppEnvironmentQuery(href: string, env: AppEnvironment): string {
  try {
    const url = new URL(href);
    url.searchParams.set(APP_ENVIRONMENT_QUERY_PARAM, env);
    return url.toString();
  } catch {
    return href;
  }
}

/**
 * Persist an environment choice and reload to re-bake the config constants.
 *
 * The reload goes to a URL carrying `?env=<env>`, which outranks everything on
 * the next load (and is persisted again there), so the switch holds even when
 * storage refuses the write or a stale `?env=` was in the URL (codex,
 * 2026-09-02). Storage is written first as the durable copy.
 */
export function applyAppEnvironment(env: AppEnvironment): void {
  if (typeof window === 'undefined') return;
  // A staging-only host never switches worlds, whatever calls this.
  if (IS_STAGING_ONLY_HOST) return;
  try {
    window.localStorage.setItem(APP_ENVIRONMENT_STORAGE_KEY, env);
  } catch {
    // No storage: the query in the reload URL still decides the next load.
  }
  let target: string | null = null;
  try {
    target = withAppEnvironmentQuery(window.location.href, env);
  } catch {
    target = null;
  }
  if (target && target !== window.location.href) {
    window.location.assign(target);
  } else {
    window.location.reload();
  }
}
