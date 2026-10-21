/**
 * The app's one way to report an error.
 *
 * Callers name a MESSAGE from a fixed union and pass booleans. They do not
 * pass an error, a string they built, or anything derived from a note - there
 * is deliberately no parameter that could carry one. What actually leaves is
 * constructed in services/error-reports-event.ts; this module is the entry point
 * and the platform split.
 *
 * Reporting is OFF unless EXPO_PUBLIC_SENTRY_DSN is set, and is web-only:
 * services/error-reports-sentry.ts is a no-op that Metro uses for native, and
 * `.web.ts` next to it is the real client.
 */
import { ACTIVE_APP_ENVIRONMENT } from '@/config/app-environment';
import { SENTRY_DSN, SENTRY_RELEASE } from '@/config/env';
import { onEgressRefusal } from '@/services/egress-policy';
import { initSentry, sendErrorReportEvent } from '@/services/error-reports-sentry';
import { RELAYED_SPEND_MESSAGES, type ErrorReportFlags, type ErrorReportMessageKey } from '@/services/error-reports-event';
import { resolveStage, type ErrorReportWalletKind } from '@/services/error-reports-failure';
import { onErrorReportsEnabledChange, readErrorReportsEnabled } from '@/services/error-reports-setting';

export type { ErrorReportFlags, ErrorReportMessageKey };

/**
 * The values a staging build may attach. Never read on a build that is not
 * allowed to send them - see `diagnosticsAllowed` below.
 */
export type ErrorReportDiagnostic = {
  stage?: string;
  detail?: string;
  address?: string;
  amount?: string;
  asset?: string;
  chainId?: number | string;
};

/**
 * Identifiers that travel in every environment, prod included.
 *
 * Both are SOURCE TEXT: a class name and a component name, the same string for
 * every user who reaches that path. The constructor refuses anything that is
 * not a bare JS identifier, so a caller cannot widen this by passing a value
 * here, however it is spelled. See ALLOWED_CODE_KEYS in error-reports-event.ts.
 */
export type ErrorReportCode = {
  errorName?: string;
  componentFrame?: string;
};

/**
 * May this session attach addresses, amounts and raw error text?
 *
 * ONE signal: the active environment is `staging`, meaning the session is
 * pointed at the test contracts. That is the question that actually matters,
 * because it is what decides whether the money in front of the user is real.
 * A staging session is test funds by construction, whoever is driving it and
 * whichever build served the page.
 *
 * It replaced a three-way conjunction that also required `TEST_MODE` and a
 * non-production hostname (2026-09-16, same day). Both were wrong for the
 * case that matters: `v2.privacypools.com?env=staging` is the URL the team is
 * told to use for staging in #qa, and it is served by the PROD deployment,
 * which builds with TEST_MODE false. So the two extra conjuncts did not add
 * defence in depth, they switched the feature off in exactly the place it was
 * asked for, and left it on only in preview builds.
 *
 * THE TRADE, STATED PLAINLY. `?env=staging` is a query parameter, so any
 * visitor to the production domain can set it. In such a session the pool
 * contracts are the staging ones and the notes are test notes, but the WALLET
 * ADDRESS is still their real address, and a failure will report it. That is
 * the accepted cost of being able to diagnose staging from the public URL, and
 * it is the product owner's call (Pat, 2026-09-16: "v2.privacypools.com?env=
 * staging must provide the rich data"). What is NOT traded away: a prod-
 * environment session - every real-money session - still sends nothing but
 * booleans, which is the boundary the 2026-09-10 disclosure was about.
 *
 * The environment is read once at module load. That is not a race with
 * `?env=staging`: changing the environment reloads the page, so this and
 * ACTIVE_APP_ENVIRONMENT are always from the same snapshot.
 *
 * DEBUG MODE IS THE SECOND SIGNAL (Pat, 2026-09-22: "make it send all when
 * user is in debug mode, even in prod"). `ppv2_debug` is the switch behind the
 * in-app debug panel, and someone who has turned it on is diagnosing this
 * session deliberately. It is read PER EVENT rather than at page load, because
 * the panel toggles it live and a gate that needed a reload would be off in
 * exactly the moment it was turned on. Turning it off closes the gate again on
 * the next report.
 *
 * The trade this one adds, stated as plainly as the one above: a prod session
 * with debug on reports the real address and the real amount. That is the
 * point of asking for it, and it is one switch away from the user, not the
 * default for anyone who has not touched it.
 */
const diagnosticsAllowed = (): boolean => ACTIVE_APP_ENVIRONMENT === 'staging' || debugModeOn();

/** The switch behind the in-app debug panel. Declared here, hoisted above. */
function debugModeOn(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('ppv2_debug') === '1';
  } catch {
    // A blocked or absent store is not debug mode.
    return false;
  }
}

let stopEgressRelay: (() => void) | undefined;

/**
 * Report a failure.
 *
 * A no-op when error reporting was never started, which is the normal state in
 * tests, in native builds, and in any deployment without a DSN.
 */
export function reportErrorReport(
  message: ErrorReportMessageKey,
  flags: ErrorReportFlags = {},
  diagnostic?: ErrorReportDiagnostic,
  code?: ErrorReportCode,
  failure?: ErrorReportFailure,
): void {
  // The user turned reports off: nothing is even handed to the client.
  if (!readErrorReportsEnabled()) return;
  // Passed unconditionally by callers. What decides whether any of it leaves
  // is `diagnosticsAllowed`, applied in the constructor, not here: a call site
  // that has to remember the rule is a call site that will eventually forget.
  // `code` is the same deal in reverse: it always leaves, and what makes that
  // safe is the identifier filter in the constructor, not the caller's care.
  sendErrorReportEvent({
    message,
    ...flags,
    ...(diagnostic ? { diagnostic } : {}),
    ...(code ? { code } : {}),
    ...(failure
      ? {
          failure: {
            // A relayed spend the relayer already accepted stays at confirm
            // whatever the call site names, so the constructor reports it
            // without chain or asset (RELAYED_SPEND_MESSAGES).
            stage: RELAYED_SPEND_MESSAGES.includes(message) && failure.phase === 'confirm'
              ? 'confirm'
              : resolveStage(failure.stage, failure.phase),
            chainId: failure.chainId,
            asset: failure.asset,
            isYield: failure.isYield,
            walletKind: walletContext.walletKind,
            connector: walletContext.connector,
          },
        }
      : {}),
  }, failure?.error);
}

/**
 * A flow failure, described in fields that travel in EVERY environment.
 *
 * `stage` is the call site's own stage name or an enum member, and `phase` is
 * the stage the flow last entered; both are folded onto the stage enum before
 * anything leaves. `error` is read for its class and its stack frames only, in
 * services/error-reports-event.ts, never for its message. `chainId` and `asset` are
 * checked there against the configured chain and token lists.
 */
export type ErrorReportFailure = {
  stage?: string;
  phase?: string;
  error?: unknown;
  chainId?: number | string;
  asset?: string;
  isYield?: boolean;
};

/** The connected wallet, published by the SDK provider. Enums only. */
let walletContext: { walletKind: ErrorReportWalletKind; connector?: string } = { walletKind: 'unknown' };

export function setErrorReportWallet(walletKind: ErrorReportWalletKind, connector: string | undefined): void {
  walletContext = { walletKind, connector };
}

/** The configured chain ids and token symbols the failure tags are checked against. */
export type ErrorReportCatalog = {
  knownChainIds: readonly number[];
  knownAssetSymbols: readonly string[];
};

/**
 * Start the reporter, and relay egress refusals into it.
 *
 * The relay is the reason this is worth having at all: a fail-closed policy
 * that refuses an outbound request is only half a defence if nobody finds
 * out. The refusal reason names a route and a key and never a value, which is
 * a property services/egress-policy.ts documents and its own tests assert.
 *
 * Returns a teardown so a caller that starts it can stop it. Safe to call
 * twice; the client initialises once.
 */
export function initErrorReport(catalog?: ErrorReportCatalog): () => void {
  if (!SENTRY_DSN) return () => {};
  // Off: the SDK is not even loaded. Turning it on starts it in place.
  if (!readErrorReportsEnabled()) {
    const stop = onErrorReportsEnabledChange((enabled) => {
      if (!enabled) return;
      stop();
      teardown = initErrorReport(catalog);
    });
    let teardown: () => void = () => {};
    return () => { stop(); teardown(); };
  }
  if (
    !initSentry(SENTRY_DSN, {
      environment: ACTIVE_APP_ENVIRONMENT,
      release: SENTRY_RELEASE,
      diagnosticsAllowed,
      enabled: () => readErrorReportsEnabled(),
      knownChainIds: catalog?.knownChainIds,
      knownAssetSymbols: catalog?.knownAssetSymbols,
      // Written by `sentry-cli sourcemaps inject` (scripts/sentry-sourcemaps.mjs).
      debugIds: () => (globalThis as { _sentryDebugIds?: unknown })._sentryDebugIds,
      origin: typeof globalThis.location?.origin === 'string' ? globalThis.location.origin : undefined,
    })
  ) {
    return () => {};
  }
  stopEgressRelay?.();
  stopEgressRelay = onEgressRefusal((party, reason) => {
    if (!readErrorReportsEnabled()) return;
    sendErrorReportEvent({ message: 'egress-refused', egressParty: party, egressReason: reason });
  });
  return () => {
    stopEgressRelay?.();
    stopEgressRelay = undefined;
  };
}
