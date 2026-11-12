/**
 * Where a freshly-connected account should land.
 *
 * Kept pure and separate from the component that performs the navigation, so
 * the "should we redirect at all?" rules are testable without a browser — this
 * is a one-shot side effect on a transition, which is exactly the kind of logic
 * that silently rots.
 */

/** The subset of a pool row this decision needs. */
export interface BalanceLike {
  /** Full-precision decimal balance, e.g. "0.07". */
  balanceTokenExact?: string;
  /** Full-precision decimal pending balance. */
  pendingTokenExact?: string;
}

/**
 * Does the account hold anything at all — settled OR pending?
 *
 * Reads the EXACT decimal fields, not the display strings: the rounded display
 * value of a dust balance is "0" (and the USD figure "$0"), so keying off those
 * would send a holder of 0.00001 ETH to an empty-looking dashboard.
 */
export function hasAnyBalance(pools: readonly BalanceLike[] | null | undefined): boolean {
  if (!pools?.length) return false;
  return pools.some((p) => isPositiveAmount(p.balanceTokenExact) || isPositiveAmount(p.pendingTokenExact));
}

function isPositiveAmount(value: string | undefined): boolean {
  if (!value) return false;
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
}

/** The subset of an activity row this decision needs. */
export interface ActivityLike {
  /** Public depositor address from the ASP event feed. */
  fullAddress?: string;
  type?: string;
  tokenAmount?: number;
}

/**
 * Has this address deposited, according to PUBLIC data?
 *
 * This is the keystore-free signal, and it is the one that matters on connect.
 * A shielded balance (hasAnyBalance) comes from note discovery, which needs a
 * SIGNED keystore session — so on a plain wallet connect it is always empty and
 * can never be the trigger. Deposit events, by contrast, carry the depositor's
 * address in the clear in the ASP feed, exactly as the notification centre's
 * "mine" tab already matches them.
 *
 * The trade-off is inherent to not signing: public deposits prove this address
 * HAS an account here, not what it currently holds — the balance itself is
 * private. Landing them on the balances panel (where they are prompted to sign
 * in and sync) is the right response to that, and strictly better than landing a
 * returning depositor on a page that looks like a stranger's.
 */
export function hasPublicDepositActivity(
  transactions: readonly ActivityLike[] | null | undefined,
  address: string | null | undefined,
): boolean {
  if (!transactions?.length || !address) return false;
  const target = address.toLowerCase();
  return transactions.some(
    (tx) =>
      (tx.fullAddress ?? '').toLowerCase() === target
      && (tx.type ?? '').toLowerCase() === 'deposit'
      && (tx.tokenAmount ?? 0) > 0,
  );
}

export interface ConnectLandingInput {
  /** Non-Classic only — Classic has no panel to land on. */
  isNewDesign: boolean;
  /** Has the wallet state settled since mount? Guards session restore. */
  settled: boolean;
  /** Is a redirect currently armed (a connect happened, not yet acted on)? */
  armed: boolean;
  /** Have balances finished loading? A pending load is not "no balance". */
  balancesLoading: boolean;
  /**
   * Is there any evidence this address has an account here — a known shielded
   * balance OR public deposit activity. See hasPublicDepositActivity for why
   * the public half is the one that fires on a plain wallet connect.
   */
  hasBalance: boolean;
  /** Has the user already navigated somewhere since connecting? */
  userNavigated: boolean;
  /** Is a panel already open? Then there is nothing to do. */
  panelAlreadyOpen: boolean;
}

/**
 * Whether to send the user to the balances panel right now.
 *
 * Every condition is a reason NOT to hijack navigation:
 *  - Classic has no panel;
 *  - before the wallet state settles, a restored session looks like a connect;
 *  - a still-loading balance must not be read as an empty one;
 *  - once the user has navigated anywhere themselves, their choice wins — this
 *    is what keeps the redirect a one-shot rather than a trap.
 */
export function shouldOpenBalancesOnConnect(input: ConnectLandingInput): boolean {
  const { isNewDesign, settled, armed, balancesLoading, hasBalance, userNavigated, panelAlreadyOpen } = input;
  if (!isNewDesign) return false;
  if (!settled || !armed) return false;
  if (userNavigated || panelAlreadyOpen) return false;
  if (balancesLoading) return false;
  return hasBalance;
}

/**
 * Durable lifecycle for the connect landing.
 *
 * The component owns the transitions between these phases; this service owns
 * the invariant for each observation. Keeping time out of the input is
 * deliberate: a funded account remains eligible however late the pool data or
 * router becomes ready, and an externally stripped panel remains repairable
 * for as long as the phase is `enforcing`.
 */
export type ConnectLandingPhase = 'waiting' | 'armed' | 'enforcing' | 'stopped';

export type ConnectLandingInvariantDecision = 'wait' | 'stop' | 'open' | 'repair' | 'satisfied';

export interface ConnectLandingInvariantInput {
  isNewDesign: boolean;
  phase: ConnectLandingPhase;
  routerReady: boolean;
  funded: boolean;
  pathname: string;
  /** Set only for an intentional, managed close/switch — never a silent URL rewrite. */
  dismissed: boolean;
  /** Current URL panel value. */
  panel: string | null;
}

/**
 * Decide how the component should uphold the balances-landing invariant.
 *
 * `open` is the first landing from `armed`; `repair` restores a panel removed
 * by external router/history churn after landing. The caller promotes `open`
 * to `enforcing`, and makes `stop` terminal for the rest of this mount.
 */
export function decideConnectLandingInvariant(
  input: ConnectLandingInvariantInput,
): ConnectLandingInvariantDecision {
  const { isNewDesign, phase, routerReady, funded, pathname, dismissed, panel } = input;

  if (phase === 'stopped' || dismissed) return 'stop';
  // Being off home is a user choice AGAINST the landing only once an identity
  // has armed it. Before that (`waiting`) it is boot noise — Expo hydration
  // briefly reports a transient pathname, and a terminal stop taken then kills
  // the landing for the whole mount before the wallet has even reported.
  if (routerReady && pathname !== '/') return phase === 'waiting' ? 'wait' : 'stop';
  if (!isNewDesign || phase === 'waiting' || !routerReady || !funded) return 'wait';
  if (panel === 'balances') return 'satisfied';
  if (phase === 'armed') return 'open';
  return 'repair';
}

export interface ConnectLandingSeedInput {
  /** True only for the armed -> enforcing transition, never for URL repair. */
  firstLanding: boolean;
  sessionLocked: boolean;
  hasCachedBalance: boolean;
  /** Latches after the first landing whether or not a prompt was necessary. */
  seedHandled: boolean;
  /**
   * Sui or Stellar is the selected chain. The unlock dialog signs the EVM
   * session only, so there it would ask MetaMask (on Sepolia) instead of the
   * chain's own wallet. Those chains unlock from their own Sign in buttons.
   */
  nonEvmChain: boolean;
}

/** The unlock invitation is a one-time companion to the first landing only. */
export function shouldOpenSeedOnConnectLanding(input: ConnectLandingSeedInput): boolean {
  return input.firstLanding
    && !input.nonEvmChain
    && !input.seedHandled
    && input.sessionLocked
    && !input.hasCachedBalance;
}
