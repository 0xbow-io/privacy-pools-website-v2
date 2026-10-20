/**
 * What this app is allowed to tell an error reporter.
 *
 * CONSTRUCTED, NOT REDACTED. This builds a new event from an allowlist and
 * throws the original away. It does not attempt to scrub the error it was
 * given, and that is the whole point: an SDK, RPC or relayer error string can
 * carry an amount, an address, a label or a commitment anywhere inside it -
 * inside a message, a `cause` chain, a stack frame, a URL in a breadcrumb, a
 * serialised request body. Redaction has to anticipate every one of those.
 * Construction does not have to anticipate anything, because nothing crosses
 * over unless it is named here.
 *
 * This is the same lesson as services/egress-policy.ts, applied to the other
 * direction: an allowlist cannot be defeated by a payload shape nobody thought
 * of. It is written down twice because it was learned the hard way - the
 * 2026-09-10 disclosure included Sentry receiving the wallet address, the
 * withdrawal amount and the recipient, and none of that was deliberate. It
 * arrived as ordinary error context.
 *
 * Pure and dependency-free so it can be tested without a Sentry runtime.
 */

/** The minimum shape this module needs. Deliberately not Sentry's type. */
export type IncomingEvent = {
  contexts?: Record<string, Record<string, unknown> | undefined>;
  [key: string]: unknown;
};

export type OutgoingEvent = {
  /** Carried over so the envelope header can address the event. Never ours. */
  event_id?: string;
  timestamp?: number;
  platform: 'javascript';
  environment?: string;
  release?: string;
  level: 'error' | 'warning';
  message: string;
  contexts?: {
    flags?: Record<string, boolean>;
    egress?: Record<string, string>;
    diagnostic?: Record<string, string>;
    code?: Record<string, string>;
  };
};

/**
 * Build-level labels, supplied by us rather than read off the event.
 *
 * `diagnosticsAllowed` is the gate on `contexts.diagnostic` and it lives HERE,
 * in the meta the reporter is initialised with, rather than at the call sites.
 * A call site can then pass a diagnostic bag unconditionally and be wrong
 * about the build without consequence: the constructor drops it. Defaults to
 * false, so a caller that forgets the field gets the private behaviour.
 *
 * It may be a FUNCTION, read once per event. A boolean would be read when the
 * reporter is initialised, which is page load, and one of the two things that
 * open the gate is a switch the user can flip while the page is open (Pat,
 * 2026-09-22: debug mode sends everything, in prod too). A thunk that throws
 * is treated as false, like an absent field.
 */
export type TelemetryMeta = {
  environment?: string;
  release?: string;
  diagnosticsAllowed?: boolean | (() => boolean);
};

/**
 * Context keys that may be forwarded, and only as booleans.
 *
 * A boolean cannot carry an amount. "hasAspLeaves: false" is exactly as
 * diagnostic as the array would have been for the question anyone actually
 * asks of it, and it discloses nothing.
 */
export const ALLOWED_FLAGS = Object.freeze([
  'hasAmount',
  'hasRecipient',
  'hasPoolAccount',
  'hasCommitment',
  'hasAspLeaves',
  'hasStateLeaves',
  'hasRelayer',
  'hasQuote',
  'isSwap',
  'isBatch',
  'testMode',
  // Failure CLASS, set by services/telemetry-cause.ts. At most one is ever
  // true. These say what went wrong; the ten above say what the flow had.
  'isUserRejected',
  'isQuoteExpired',
  'isSessionError',
  'isRelayerRejected',
  'isValidationError',
  'isNetworkError',
  'isChainReverted',
// Frozen, not just `as const`: `as const` is a compile-time claim and this
// array is EXPORTED so a guard test can read it, which also hands any runtime
// a push(). A new name must be a reviewed edit to this file, not a line
// somewhere else (codex, 2026-09-15).
] as const);

/**
 * Keys that may appear in `contexts.diagnostic`, which carries VALUES.
 *
 * This is the one place in this module where an allowlist is not enough on its
 * own, because these fields say exactly what the rest of the file exists to
 * prevent: an address, an amount, the original error text. They are here
 * because a staging build that cannot be debugged is its own kind of failure
 * (six undiagnosable deposit failures in one morning, 2026-09-16), and because
 * a staging tester is a member of the team exercising test funds, not a user.
 *
 * What makes it safe is the GATE, not the list: `meta.diagnosticsAllowed`,
 * computed in services/telemetry.ts, which explains what it trades.
 *
 * NAME THESE CAREFULLY. `asset` was called `token` for its first two hours and
 * arrived at Sentry as the literal string "[Filtered]": server-side scrubbing
 * redacts any field named `token`, assuming it is an auth token. So the one
 * field that would have identified the ETH-versus-USDC mismatch behind the
 * withdraw failures was the one field silently eaten, on a payload that
 * otherwise looked complete. Avoid `token`, `secret`, `key`, `auth`,
 * `password`, `session` and their relatives here, and check a real event
 * rather than trusting that what was sent is what landed.
 */
export const ALLOWED_DIAGNOSTIC_KEYS = Object.freeze([
  'stage',
  'detail',
  'address',
  'amount',
  'asset',
  'chainId',
] as const);

/** Values are capped: an error message can otherwise be arbitrarily long. */
const DIAGNOSTIC_VALUE_MAX = 300;

/**
 * Keys that travel in EVERY environment, including a real-money prod session.
 *
 * Everything else with content in it is gated, which left a prod failure
 * reporting that something broke and nothing about what (Pat, 2026-09-22: "can
 * you make it send some more info without doxing too much"). These are the
 * answer, and they are safe for one reason: a CODE IDENTIFIER is not a value.
 * `TypeError` and `SwapModalProvider` are written in a source file and are the
 * same string for every user who hits that path. An address, an amount, a
 * symbol or a note is not, and cannot become one, because `codeIdentifiers`
 * below refuses anything that is not a bare JS identifier: no digits at the
 * start, no `0x`, no dots, no spaces, no punctuation of any kind.
 *
 * That refusal is the whole guarantee, so keep it strict. A key added here
 * whose value is interpolated at runtime would defeat it however innocent the
 * name looks.
 */
export const ALLOWED_CODE_KEYS = Object.freeze(['errorName', 'componentFrame'] as const);

/**
 * A bare JS identifier, and nothing else.
 *
 * `0xabc…` fails on the digit, `1.5` on the dot, `12 USDC` on the space,
 * `withdraw failed: 0x…` on the colon. What survives is a class name or a
 * component name, which is source text.
 */
const CODE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Long enough for the longest name in this codebase, short enough to notice. */
const CODE_VALUE_MAX = 64;

/**
 * Fixed messages. The ONLY free-standing strings that may reach the reporter.
 *
 * A free-form message is how the original error gets back in: someone writes
 * `captureException(new Error(\`withdraw failed: \${err.message}\`))` and the
 * relayer's rejection text, which quotes the amount, goes with it. Callers
 * pick a member of this union instead.
 */
export const TELEMETRY_MESSAGES = {
  'deposit-failed': 'Deposit operation failed',
  'withdraw-failed': 'Withdrawal operation failed',
  'transfer-failed': 'Transfer operation failed',
  'ragequit-failed': 'Ragequit operation failed',
  'swap-failed': 'Swap operation failed',
  'discovery-failed': 'Note discovery failed',
  'egress-refused': 'Outbound request refused by the egress policy',
  'client-failed': 'Client operation failed',
} as const;

export type TelemetryMessageKey = keyof typeof TELEMETRY_MESSAGES;

export function isTelemetryMessageKey(value: unknown): value is TelemetryMessageKey {
  return typeof value === 'string' && Object.hasOwn(TELEMETRY_MESSAGES, value);
}

/**
 * The event id Sentry generated for this report.
 *
 * Forwarded, not dropped, because `createEventEnvelopeHeaders` addresses the
 * envelope by it - an event without one is a delivery question we do not want
 * to be answering later. It is a random 32-hex id minted by the SDK, so it
 * carries nothing; the shape check is what keeps it that way if something
 * upstream ever starts putting its own string there.
 */
function safeEventId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) ? value : undefined;
}

/** Seconds since the epoch, as Sentry stamps it. Anything else is dropped. */
function safeTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Our own build labels. Capped, because "ours" is an assumption worth bounding. */
function safeLabel(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : undefined;
}

/**
 * Build the event that may be sent, from the event Sentry offered.
 *
 * Returns null when there is nothing safe and useful to say, which the caller
 * turns into "drop this event entirely". Dropping is always acceptable: a
 * missing error report costs us a debugging hint, and a leaking one costs a
 * user their privacy.
 */
export function privateTelemetryEvent(
  event: IncomingEvent | null | undefined,
  meta: TelemetryMeta = {},
): OutgoingEvent | null {
  if (!event) return null;
  const context = event.contexts?.telemetry;

  const flags: Record<string, boolean> = {};
  for (const key of ALLOWED_FLAGS) {
    const value = context?.[key];
    // Strictly boolean. A truthy string would carry its own content through.
    if (typeof value === 'boolean') flags[key] = value;
  }

  const key = context?.message;
  const message = isTelemetryMessageKey(key)
    ? TELEMETRY_MESSAGES[key]
    : TELEMETRY_MESSAGES['client-failed'];

  // The egress policy's refusal reason names a ROUTE and a KEY and never a
  // value - that is a documented property of services/egress-policy.ts, and
  // its own tests assert it. It is the one caller-supplied string allowed
  // through, because it is the one string built to be safe.
  const egressReason = context?.egressReason;
  const egressParty = context?.egressParty;
  const egress =
    typeof egressReason === 'string'
      ? {
          reason: egressReason.slice(0, 300),
          ...(typeof egressParty === 'string' ? { party: egressParty.slice(0, 20) } : {}),
        }
      : undefined;

  // Values, and only in a staging session. `meta.diagnosticsAllowed` defaults
  // to absent, so a build that forgets to supply it sends nothing.
  //
  // It used to ALSO require `flags.testMode === true`, which was removed the
  // same day (2026-09-16): the prod deployment builds with TEST_MODE false and
  // serves `v2.privacypools.com?env=staging`, the URL the team is told to use
  // for staging, so that second half silently disabled the feature exactly
  // where it was wanted. The environment is the signal that means something -
  // it says whether the funds are real - and it is computed in
  // services/telemetry.ts, which explains the trade this accepts.
  const diagnostic = diagnosticsAllowed(meta) ? diagnosticFields(context?.diagnostic) : undefined;

  // Identifiers, in every environment. Ungated because nothing that passes the
  // filter is derived from this user.
  const code = codeIdentifiers(context?.code);

  const eventId = safeEventId(event.event_id);
  const timestamp = safeTimestamp(event.timestamp);
  const environment = safeLabel(meta.environment);
  const release = safeLabel(meta.release);

  return {
    ...(eventId ? { event_id: eventId } : {}),
    ...(timestamp ? { timestamp } : {}),
    platform: 'javascript',
    ...(environment ? { environment } : {}),
    ...(release ? { release } : {}),
    level: key === 'egress-refused' ? 'warning' : 'error',
    message,
    contexts: {
      ...(Object.keys(flags).length > 0 ? { flags } : {}),
      ...(egress ? { egress } : {}),
      ...(diagnostic ? { diagnostic } : {}),
      ...(code ? { code } : {}),
    },
  };
}

/**
 * Resolve the gate, once, for this event.
 *
 * A thunk is CALLED here rather than at init so a debug switch flipped mid
 * session takes effect on the next report. A thunk that throws, which is what
 * a blocked `localStorage` does, is false: the private behaviour is the one
 * that survives an error.
 */
function diagnosticsAllowed(meta: TelemetryMeta): boolean {
  const gate = meta.diagnosticsAllowed;
  if (typeof gate === 'function') {
    try {
      return gate() === true;
    } catch {
      return false;
    }
  }
  return gate === true;
}

/**
 * Read the code bag through its allowlist, keeping only bare identifiers.
 *
 * Unlike `diagnosticFields` this accepts strings ONLY. A number here would be
 * a value, since no identifier is a number, and stringifying one would be the
 * exact hole this filter exists to close.
 */
function codeIdentifiers(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ALLOWED_CODE_KEYS) {
    const raw = source[key];
    if (typeof raw !== 'string') continue;
    // Tested BEFORE any trimming or slicing: a truncated value that then
    // matched would be a value that got through.
    if (raw.length > CODE_VALUE_MAX || !CODE_IDENTIFIER.test(raw)) continue;
    out[key] = raw;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Read the diagnostic bag through its allowlist.
 *
 * Numbers are stringified because a chain id arrives as one; everything else
 * must already be a string, so an object or an array cannot ride in whole.
 * Returns undefined rather than an empty object when nothing survives, so the
 * context key is absent instead of present and empty.
 */
function diagnosticFields(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of ALLOWED_DIAGNOSTIC_KEYS) {
    const raw = source[key];
    const text =
      typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : '';
    if (text.length > 0) out[key] = text.slice(0, DIAGNOSTIC_VALUE_MAX);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The flag names a caller may pass. The runtime allowlist above is the real
 * gate; this exists so a typo is a compile error rather than a silently
 * dropped field.
 */
export type TelemetryFlagName = (typeof ALLOWED_FLAGS)[number];
export type TelemetryFlags = Partial<Record<TelemetryFlagName, boolean>>;
