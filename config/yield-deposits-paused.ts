// Vault deposit kill switch. A leaf module on purpose: config/environments.ts
// (the token registry) and config/yield.ts (the money resolvers) both read it,
// and config/yield.ts already imports config/environments.ts.
//
// EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED=true blocks NEW deposits into every yield
// vault pool. Default OFF, so an unset env changes nothing. It is a build-time
// variable (Expo inlines it), so flipping it needs a redeploy.
//
// What it pauses: every way INTO a vault (Shield, pool page Deposit, deep
// links, swap or conversion into a vault, payment requests into a vault). The
// plain pool for the same asset is NOT offered instead: it is closed or
// superseded on purpose (services/shield-pools.ts).
//
// What it never touches: every exit. Withdraw (including the redemption to
// the underlying), Send, claim, ragequit, loose-share unwrap, Portfolio and
// history read the share-side resolvers, which ignore this flag.

// Read via a STATIC `process.env.EXPO_PUBLIC_*` member: Expo only inlines
// static member access (see config/yield.ts).
export const YIELD_DEPOSITS_PAUSED = process.env.EXPO_PUBLIC_YIELD_DEPOSITS_PAUSED?.trim().toLowerCase() === 'true';

/** True when new vault deposits are paused for this build. */
export function yieldDepositsPaused(): boolean {
  return YIELD_DEPOSITS_PAUSED;
}

/** Picker subtitle for a vault asset while deposits are paused. */
export const DEPOSITS_PAUSED_SUBTITLE = 'Deposits paused';

/** The one-line reason a refused vault deposit gives. */
export const VAULT_DEPOSITS_PAUSED_MESSAGE = 'Vault deposits are paused. Withdraw and send still work.';
