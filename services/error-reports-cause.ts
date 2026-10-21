/**
 * What KIND of failure this was, as booleans.
 *
 * The reporter has been able to say that a deposit failed since 2026-09-15,
 * and has never been able to say why: the three providers pass only
 * `testMode`, and services/error-reports-event.ts throws the original error away
 * by design. Six deposit failures arrived over one morning and not one of them
 * was diagnosable (2026-09-16).
 *
 * The fix is NOT to start forwarding the error. It is to answer the question
 * the error would have answered, in a shape that cannot carry a value: a
 * fixed set of booleans naming the failure CLASS. "isUserRejected: true" is
 * the whole answer to "did the wallet prompt get dismissed", and it discloses
 * nothing about who dismissed it or for how much.
 *
 * Note what is deliberately NOT here. `hasAmount`, `hasRelayer` and `hasQuote`
 * exist in the allowlist and were the obvious thing to reach for, but they are
 * true for essentially every failure of a flow that has an amount, a relayer
 * and a quote - so they separate nothing - and they describe the user's
 * transaction rather than the fault. These flags describe the fault.
 *
 * Pure and dependency-free, like services/error-reports-event.ts, so the
 * classification can be tested without a Sentry runtime or a provider tree.
 */
import type { ErrorReportFlags } from '@/services/error-reports-event';

/**
 * Patterns are matched against the app's own error text and the underlying
 * error's message. Order matters: the first match wins, most specific first,
 * because a single failure legitimately answers to more than one of these
 * ("user rejected" often also mentions the relayer that was about to be used).
 */
const CLASSIFIERS: ReadonlyArray<readonly [keyof ErrorReportFlags, RegExp]> = [
  // A dismissed wallet prompt. By far the most common "failure" that is not
  // one, and the first thing worth ruling out.
  ['isUserRejected', /\buser (?:rejected|denied|cancell?ed)\b|transaction was rejected/i],
  // The relayer quote outliving the proving window is a known recurring shape
  // (see reference: quote TTL vs proving window), so it gets its own bit.
  ['isQuoteExpired', /\bquote\b[^.]{0,40}\bexpired\b|\bexpired\b[^.]{0,40}\bquote\b/i],
  // TRANSPORT BEFORE SUBJECT. This sits above the relayer and keystore
  // patterns deliberately: "Could not reach the relayer ... Failed to fetch"
  // is an outage, not a rejection, and the first version of this file called
  // it isRelayerRejected because the word "relayer" appeared earlier in the
  // sentence (codex, 2026-09-16). The same text also made a keystore lookup
  // that never completed look like a broken session. A request that got no
  // answer is a network fault whatever it was asking for.
  ['isNetworkError', /failed to fetch|network (?:error|request failed)|could not reach|timed? ?out|econnreset|socket hang up|load failed/i],
  // The transaction was broadcast and the chain rejected it. Distinct from
  // every class below in the only way that matters to a user: gas was spent.
  // Added after the first real diagnostic event (2026-09-16) reported
  // "Transaction reverted on-chain. Your notes were NOT spent." and carried no
  // class at all, because nothing here matched it.
  ['isChainReverted', /reverted on-chain|transaction reverted|execution reverted|\brevert(?:ed)?\b/i],
  // No session to act with. Distinct from a network fault: nothing was sent.
  ['isSessionError', /wallet not connected|public client unavailable|network switched|keystore/i],
  // The relayer answered, and said no. Anchored on `relayer` so it does not
  // also claim `relay`, which names the contract rather than the service.
  ['isRelayerRejected', /\brelayers?\b/i],
  // Refused before anything was signed, by us or by the SDK.
  ['isValidationError', /minimum|insufficient|not available on this network|cannot (?:shield|withdraw)|unsupported|invalid/i],
];

/** The error's own text, without assuming it is an Error. */
function causeText(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (typeof cause === 'string') return cause;
  return '';
}

/**
 * Classify one failure.
 *
 * Returns at most one class flag. Returning several would invite reading the
 * combination as a finer diagnosis than the patterns can actually support.
 * When nothing matches, no flag is set: an absent bit honestly says "we could
 * not tell", where a false one would claim we had ruled it out.
 */
export function classifyFailure(message: string | null, cause?: unknown): ErrorReportFlags {
  const text = `${message ?? ''}\n${causeText(cause)}`;
  if (!text.trim()) return {};
  for (const [flag, pattern] of CLASSIFIERS) {
    if (pattern.test(text)) return { [flag]: true };
  }
  return {};
}
