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

import {
  classifyReason,
  exceptionType,
  parseStackFrames,
  safeAssetSymbol,
  safeChainId,
  safeConnector,
  safeStage,
  safeWalletKind,
  type ErrorReportFrame,
} from '@/services/error-reports-failure';

/** The minimum shape this module needs. Deliberately not Sentry's type. */
export type IncomingEvent = {
  contexts?: Record<string, Record<string, unknown> | undefined>;
  [key: string]: unknown;
};

/**
 * Sentry looks up a location (`user.geo`) from the connection's IP when an event
 * arrives, unless the event itself says the IP is null. Our events carry no user,
 * so without this Sentry fills one in: the "Prevent Storing of IP Addresses"
 * project switch hides the IP but a location derived from it was still saved
 * (2026-10-30, a team member's own crash report showed their city). An explicit
 * null IP stops the lookup at the source. The project switch stays on as a second layer.
 */
export const NO_USER_IP = Object.freeze({ ip_address: null }) as { readonly ip_address: null };

export type OutgoingEvent = {
  /** Carried over so the envelope header can address the event. Never ours. */
  event_id?: string;
  timestamp?: number;
  platform: 'javascript';
  environment?: string;
  release?: string;
  level: 'error' | 'warning';
  message: string;
  /** Always `{ ip_address: null }`: no user, and no IP for Sentry to infer a location from. */
  user: { readonly ip_address: null };
  contexts?: {
    flags?: Record<string, boolean>;
    egress?: Record<string, string>;
    diagnostic?: Record<string, string>;
    code?: Record<string, string>;
  };
  /**
   * Low-cardinality labels for a flow failure, all enums or values from our
   * own configuration. See services/error-reports-failure.ts.
   */
  tags?: Partial<Record<(typeof FAILURE_TAG_KEYS)[number], string>>;
  /** The exception TYPE and scrubbed frames. Never a message, never variables. */
  exception?: {
    values: Array<{
      type: string;
      stacktrace?: { frames: ErrorReportFrame[] };
    }>;
  };
  /**
   * Which uploaded source map belongs to which frame file, so Sentry can
   * resolve the frames above. Only files those frames already name, and only a
   * build-wide uuid per file (scripts/sentry-sourcemaps.mjs injects it).
   */
  debug_meta?: { images: DebugImage[] };
};

export type DebugImage = { type: 'sourcemap'; code_file: string; debug_id: string };

/** Every tag key a failure report may carry. */
export const FAILURE_TAG_KEYS = Object.freeze([
  'stage',
  'reason',
  'chainId',
  'asset',
  'isYield',
  'walletKind',
  'connector',
] as const);

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
export type ErrorReportMeta = {
  environment?: string;
  release?: string;
  diagnosticsAllowed?: boolean | (() => boolean);
  /**
   * The user's "Send anonymous error reports" switch, read per event. False,
   * or a thunk that throws, drops the event entirely. Absent means on.
   */
  enabled?: () => boolean;
  /** The app's configured chain ids. A chain id outside it is dropped. */
  knownChainIds?: readonly number[];
  /** The configured token symbols. Any other symbol is reported as `other`. */
  knownAssetSymbols?: readonly string[];
  /**
   * The debug id registry `sentry-cli sourcemaps inject` leaves on
   * `globalThis._sentryDebugIds` (an Error stack mapped to a uuid). A thunk,
   * read per event, because lazy chunks register as they load.
   */
  debugIds?: () => unknown;
  /** The app's origin. Only frames in this build's chunks on it are kept. */
  origin?: string;
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
  // Failure CLASS, set by services/error-reports-cause.ts. At most one is ever
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
 * computed in services/error-reports.ts, which explains what it trades.
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
export const ALLOWED_CODE_KEYS = Object.freeze(['errorName', 'componentFrame', 'errorShape', 'componentPosition'] as const);

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
export const ERROR_REPORT_MESSAGES = {
  'deposit-failed': 'Deposit operation failed',
  'withdraw-failed': 'Withdrawal operation failed',
  'transfer-failed': 'Transfer operation failed',
  'ragequit-failed': 'Ragequit operation failed',
  'swap-failed': 'Swap operation failed',
  'discovery-failed': 'Note discovery failed',
  'egress-refused': 'Outbound request refused by the egress policy',
  'client-failed': 'Client operation failed',
} as const;

export type ErrorReportMessageKey = keyof typeof ERROR_REPORT_MESSAGES;

export function isErrorReportMessageKey(value: unknown): value is ErrorReportMessageKey {
  return typeof value === 'string' && Object.hasOwn(ERROR_REPORT_MESSAGES, value);
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
export function privateErrorReportEvent(
  event: IncomingEvent | null | undefined,
  meta: ErrorReportMeta = {},
  /**
   * The error behind a flow failure, from Sentry's event hint. Read for its
   * CLASS and its stack frames only, each through a filter, and never copied.
   */
  originalException?: unknown,
): OutgoingEvent | null {
  if (!event) return null;
  if (meta.enabled) {
    try {
      if (!meta.enabled()) return null;
    } catch {
      return null;
    }
  }
  const context = event.contexts?.errorReport;

  const flags: Record<string, boolean> = {};
  for (const key of ALLOWED_FLAGS) {
    const value = context?.[key];
    // Strictly boolean. A truthy string would carry its own content through.
    if (typeof value === 'boolean') flags[key] = value;
  }

  const key = context?.message;
  const message = isErrorReportMessageKey(key)
    ? ERROR_REPORT_MESSAGES[key]
    : ERROR_REPORT_MESSAGES['client-failed'];

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
  // services/error-reports.ts, which explains the trade this accepts.
  const diagnostic = diagnosticsAllowed(meta) ? diagnosticFields(context?.diagnostic) : undefined;

  // Identifiers, in every environment. Ungated because nothing that passes the
  // filter is derived from this user.
  const code = codeIdentifiers(context?.code);

  // Stage, reason and context: present only when the call site described a
  // flow failure. Every value is an enum member or from our own config.
  const tags = failureTags(context?.failure, meta, originalException);
  const exception = originalException !== undefined && tags ? exceptionOf(originalException, meta.origin) : undefined;
  const debugMeta = exception ? debugMetaOf(exception, meta.debugIds, meta.origin) : undefined;

  const eventId = safeEventId(event.event_id);
  const timestamp = safeTimestamp(event.timestamp);
  const environment = safeLabel(meta.environment);
  const release = safeLabel(meta.release);

  // A RELAYED SPEND (withdraw, send, swap-out, ragequit, batch), Pat
  // 2026-10-20. The user's wallet is not involved, so walletKind and connector
  // never travel. Before the relayer accepts the transaction (including a
  // relay request it REJECTED) nothing on-chain exists to match, so the rest
  // of the event is normal. Once it accepted (stage confirm, or the chain
  // reverted it) the report could be lined up with an on-chain spend, so it
  // carries only stage, reason, exception type and frames: no chain, asset,
  // yield flag, flags, diagnostic or code bag.
  if (tags && isRelayedSpend(key)) {
    delete tags.walletKind;
    delete tags.connector;
    if (mayHaveBroadcast(tags, originalException)) {
      return {
        ...(eventId ? { event_id: eventId } : {}),
        ...(timestamp ? { timestamp } : {}),
        platform: 'javascript',
        ...(environment ? { environment } : {}),
        ...(release ? { release } : {}),
        level: 'error',
        message,
        user: NO_USER_IP,
        tags: { stage: tags.stage, reason: tags.reason },
        ...(exception ? { exception } : {}),
        ...(debugMeta ? { debug_meta: debugMeta } : {}),
      };
    }
  }

  return {
    ...(eventId ? { event_id: eventId } : {}),
    ...(timestamp ? { timestamp } : {}),
    platform: 'javascript',
    ...(environment ? { environment } : {}),
    ...(release ? { release } : {}),
    level: key === 'egress-refused' ? 'warning' : 'error',
    message,
    user: NO_USER_IP,
    contexts: {
      ...(Object.keys(flags).length > 0 ? { flags } : {}),
      ...(egress ? { egress } : {}),
      ...(diagnostic ? { diagnostic } : {}),
      ...(code ? { code } : {}),
    },
    ...(tags ? { tags } : {}),
    ...(exception ? { exception } : {}),
    ...(debugMeta ? { debug_meta: debugMeta } : {}),
  };
}

/** Flows whose spend goes through the relayer. */
export const RELAYED_SPEND_MESSAGES: readonly ErrorReportMessageKey[] = Object.freeze([
  'withdraw-failed',
  'transfer-failed',
  'swap-failed',
  'ragequit-failed',
]);

/**
 * Stages that end before anything is sent for broadcast. A relayed spend that
 * failed in one of these has nothing on-chain to be matched against.
 */
const PRE_SEND_STAGES: ReadonlySet<string> = new Set([
  'wallet-connect', 'validate', 'approve', 'relayer-check', 'recipient-check', 'quote', 'proof',
]);

/** An HTTP 4xx (not 408) anywhere in the cause chain: the relayer refused it. */
function explicitRejection(error: unknown): boolean {
  let node: unknown = error;
  for (let depth = 0; depth < 8 && node && typeof node === 'object'; depth += 1) {
    const status = (node as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) return true;
    node = (node as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Whether a relayed spend may have reached the chain. True unless it clearly
 * failed before sending: a pre-send stage, or a submit the relayer explicitly
 * refused. A partial batch, a timeout or network error after the request was
 * sent, an unknown stage, a confirm or a revert all count as broadcast.
 */
function mayHaveBroadcast(tags: NonNullable<OutgoingEvent['tags']>, error: unknown): boolean {
  if (tags.reason === 'revert') return true;
  // Earlier sub-batches of a partial batch already confirmed on-chain, so a 4xx on the last one
  // (kept as `cause`) must not make the report look like a clean pre-send refusal.
  if (isPartialBatchError(error)) return true;
  if (tags.stage && PRE_SEND_STAGES.has(tags.stage)) return false;
  if (tags.stage === 'submit' && explicitRejection(error)) return false;
  return true;
}

/** The error that says some sub-batches confirmed before a later one failed (matched by name, no import). */
function isPartialBatchError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: unknown }).name === 'BatchPartiallyWithdrawnError';
}

function isRelayedSpend(key: unknown): boolean {
  return isErrorReportMessageKey(key) && RELAYED_SPEND_MESSAGES.includes(key);
}

/**
 * The failure tags, rebuilt field by field. `failure` is what the reporter put
 * in the error reporting context. It has no `reason` field: the reason is computed
 * here from the error's class, so a caller cannot choose the string.
 */
function failureTags(
  failure: unknown,
  meta: ErrorReportMeta,
  error: unknown,
): OutgoingEvent['tags'] | undefined {
  if (!failure || typeof failure !== 'object') return undefined;
  const source = failure as Record<string, unknown>;
  const tags: NonNullable<OutgoingEvent['tags']> = {
    stage: safeStage(source.stage) ?? 'unknown',
    reason: error === undefined ? 'unknown' : classifyReason(error),
    walletKind: safeWalletKind(source.walletKind),
    connector: safeConnector(source.connector),
  };
  const chainId = safeChainId(source.chainId, meta.knownChainIds);
  if (chainId !== undefined) tags.chainId = String(chainId);
  const asset = safeAssetSymbol(source.asset, meta.knownAssetSymbols);
  if (asset !== undefined) tags.asset = asset;
  if (typeof source.isYield === 'boolean') tags.isYield = source.isYield ? 'true' : 'false';
  return tags;
}

/** The exception TYPE and its frames. Deliberately no `value`: that is the message. */
function exceptionOf(error: unknown, origin: string | undefined): OutgoingEvent['exception'] {
  const frames = error && typeof error === 'object'
    ? parseStackFrames((error as { stack?: unknown }).stack, { message: (error as { message?: unknown }).message, origin })
    : [];
  return {
    values: [{
      type: exceptionType(error),
      ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
    }],
  };
}

const DEBUG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `debug_meta.images` for the files the frames name, rebuilt from the
 * registry. Each registry key is a stack captured inside one bundle, so its
 * innermost frame is that bundle; it goes through the same path filter as the
 * event's frames, so `code_file` is a bare path with no origin or query and is
 * only kept when a frame already names it. The id must be a lowercase uuid.
 */
export function debugMetaOf(
  exception: NonNullable<OutgoingEvent['exception']>,
  registry: ErrorReportMeta['debugIds'],
  origin: string | undefined,
): OutgoingEvent['debug_meta'] | undefined {
  const files = new Set<string>();
  for (const value of exception.values) {
    for (const frame of value.stacktrace?.frames ?? []) {
      if (frame.abs_path.startsWith('/')) files.add(frame.abs_path);
    }
  }
  if (files.size === 0 || typeof registry !== 'function') return undefined;
  let ids: unknown;
  try {
    ids = registry();
  } catch {
    return undefined;
  }
  if (!ids || typeof ids !== 'object') return undefined;
  const images = new Map<string, DebugImage>();
  for (const [stack, id] of Object.entries(ids as Record<string, unknown>)) {
    if (typeof id !== 'string') continue;
    const debugId = id.toLowerCase();
    if (!DEBUG_ID.test(debugId)) continue;
    const frames = parseStackFrames(stack, { origin });
    const codeFile = frames[frames.length - 1]?.abs_path;
    if (!codeFile || !files.has(codeFile) || images.has(codeFile)) continue;
    images.set(codeFile, { type: 'sourcemap', code_file: codeFile, debug_id: debugId });
  }
  return images.size > 0 ? { images: [...images.values()] } : undefined;
}

/**
 * Resolve the gate, once, for this event.
 *
 * A thunk is CALLED here rather than at init so a debug switch flipped mid
 * session takes effect on the next report. A thunk that throws, which is what
 * a blocked `localStorage` does, is false: the private behaviour is the one
 * that survives an error.
 */
function diagnosticsAllowed(meta: ErrorReportMeta): boolean {
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
export type ErrorReportFlagName = (typeof ALLOWED_FLAGS)[number];
export type ErrorReportFlags = Partial<Record<ErrorReportFlagName, boolean>>;
