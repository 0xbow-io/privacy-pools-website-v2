// Vault deposit kill switch. A leaf module on purpose: config/environments.ts
// (the token registry) and config/yield.ts (the money resolvers) both read it,
// and config/yield.ts already imports config/environments.ts.
//
// EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED blocks NEW deposits into yield vault pools:
//   - `true`             every chain (the original switch, kept as is);
//   - `1` or `1,56`      only the vaults on those chain ids;
//   - unset, empty, `false` or anything else: off (the default).
// It is a build-time variable (Expo inlines it), so changing it needs a redeploy.
//
// What it pauses: every way INTO a vault on a paused chain (Shield, pool page
// Deposit, deep links, swap or conversion into a vault, payment requests into a
// vault). The plain pool for the same asset is NOT offered instead: it is
// closed or superseded on purpose (services/shield-pools.ts).
//
// What it never touches: every exit. Withdraw (including the redemption to
// the underlying), Send, claim, ragequit, loose-share unwrap, Portfolio and
// history read the share-side resolvers, which ignore this flag.

/** Which chains have vault deposits paused. `all` wins over `chainIds`. */
export interface YieldDepositsPause {
  all: boolean;
  chainIds: readonly number[];
}

export const NO_YIELD_DEPOSITS_PAUSE: YieldDepositsPause = { all: false, chainIds: [] };

/**
 * Pure parser (unit-tested). `true` (any case) pauses every chain; otherwise
 * the value is read as a comma-separated list of positive integer chain ids,
 * and anything that is not one is ignored. So `false`, `` and unset are off.
 */
export function parseYieldDepositsPaused(raw: string | undefined): YieldDepositsPause {
  const value = raw?.trim() ?? '';
  if (!value) return NO_YIELD_DEPOSITS_PAUSE;
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  // `true` anywhere in the list means every chain: a kill switch must never
  // narrow itself on a typo like `true,56`.
  if (parts.some((part) => part.toLowerCase() === 'true')) return { all: true, chainIds: [] };
  const chainIds = [...new Set(parts
    .filter((part) => /^[0-9]+$/.test(part))
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0))];
  const ignored = parts.filter((part) => !/^[0-9]+$/.test(part) || !(Number(part) > 0));
  if (ignored.length > 0) {
    console.warn(`[yield] EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED: ignoring "${ignored.join('", "')}". Use true or a list of chain ids.`);
  }
  return { all: false, chainIds };
}

/** True when `pause` covers `chainId`. Pure. */
export function pauseCoversChain(pause: YieldDepositsPause, chainId: number): boolean {
  return pause.all || pause.chainIds.includes(chainId);
}

/** True when `pause` covers at least one chain. Pure. */
export function pauseActive(pause: YieldDepositsPause): boolean {
  return pause.all || pause.chainIds.length > 0;
}

// Read via a STATIC `process.env.EXPO_PUBLIC_*` member: Expo only inlines
// static member access (see config/yield.ts).
/**
 * What an UNSET EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED means: Ethereum and Base are
 * paused (Aave froze its reserves there, Pat 2026-10-29, "please do"), so a
 * build needs no env to be safe. Set the var to `false` to open deposits again.
 */
export const DEFAULT_YIELD_DEPOSITS_PAUSED = '1,8453';

export const YIELD_DEPOSITS_PAUSE: YieldDepositsPause = parseYieldDepositsPaused(
  process.env.EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED ?? DEFAULT_YIELD_DEPOSITS_PAUSED,
);

/** True when vault deposits are paused on at least one chain for this build. */
export const YIELD_DEPOSITS_PAUSED = pauseActive(YIELD_DEPOSITS_PAUSE);

/** True when new vault deposits are paused on at least one chain for this build. */
export function yieldDepositsPaused(): boolean {
  return YIELD_DEPOSITS_PAUSED;
}

/** True when new vault deposits on `chainId` are paused for this build. */
export function yieldDepositsPausedOnChain(chainId: number): boolean {
  return pauseCoversChain(YIELD_DEPOSITS_PAUSE, chainId);
}

/** Picker subtitle for a vault asset while deposits are paused. */
export const DEPOSITS_PAUSED_SUBTITLE = 'Deposits paused';

/** The one-line reason a refused vault deposit gives. */
export const VAULT_DEPOSITS_PAUSED_MESSAGE = 'Vault deposits are paused. Withdraw and send still work.';

/**
 * Chains whose yield vaults sit on Aave, so "because of Aave" is true for them.
 * The default banner names only these; any other scope sets its own text.
 */
const AAVE_CHAIN_NAMES: Readonly<Record<number, string>> = { 1: 'Ethereum', 8453: 'Base', 10: 'Optimism', 42161: 'Arbitrum' };

/**
 * Default banner text for a pause naming specific chains (Pat, 2026-10-29,
 * Ethereum; 8453 Base added the same day), or null when the pause is "every
 * chain" or names a chain that is not an Aave chain.
 */
export function defaultYieldPauseBannerText(pause: YieldDepositsPause): string | null {
  if (pause.all || pause.chainIds.length === 0) return null;
  const names = pause.chainIds.map((id) => AAVE_CHAIN_NAMES[id]);
  if (names.some((name) => !name)) return null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Deposits are paused for yield assets on ${list} because of Aave.`;
}

/** The Ethereum-only default, kept for the prod test. */
export const DEFAULT_YIELD_PAUSE_BANNER_TEXT = 'Deposits are paused for yield assets on Ethereum because of Aave.';

/**
 * Pure (unit-tested): the top-of-app notice, or null for none. No pause, no
 * banner. Unset text gives the default; text set to an empty (or blank) string
 * hides the banner; any other text is shown as plain text, trimmed.
 */
export function resolveYieldPauseBannerText(pause: YieldDepositsPause, raw: string | undefined): string | null {
  if (!pauseActive(pause)) return null;
  // The default names its chains and Aave, so it only fits a pause on Aave
  // chains. Any other scope must set its own text, never show a wrong chain.
  if (raw === undefined) return defaultYieldPauseBannerText(pause);
  const text = raw.trim();
  return text.length > 0 ? text : null;
}

/** The banner this build shows, or null. Static member read, see above. */
export const YIELD_PAUSE_BANNER_TEXT: string | null = resolveYieldPauseBannerText(
  YIELD_DEPOSITS_PAUSE,
  process.env.EXPO_PUBLIC_YIELD_PAUSE_BANNER_TEXT,
);
