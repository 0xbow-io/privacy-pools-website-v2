// The SHAPE of a crash message, as one identifier.
//
// A render crash reaches Sentry as "Client operation failed" with a class name
// and a component name. For V2-APP-5 that was `Error` and `https`: nothing to act
// on. The message itself is not sent from a production session, on purpose (it can
// quote an address or an amount). The shape can: "Cannot read properties of
// undefined (reading 'decimals')" is the same sentence for every user and names
// only a property of OUR code, so it is reported as `read_undefined_decimals`.
//
// Only fixed JS and React sentences are recognised, and a name inside one is kept
// only when it is source text and not a value that happened to be a key. The app
// keys by token symbol and by chain in places, in any case (`prices['fdusd']`), so
// shape alone cannot tell `decimals` from `fdusd`. Two layers:
//   1. structure: a bare identifier, starting lowercase, not ALL CAPS, and nothing
//      that starts with `pp` (the share prefix), in any case;
//   2. identity: not equal, case-insensitively, to any token symbol, share symbol,
//      underlying symbol, native currency or chain name of the REAL configuration
//      (services/crash-name-denylist.ts reads it, nothing is hand-listed).
// That is conservative on purpose. Anything unrecognised is not reported, which
// costs a hint and never leaks. The result always passes the code-identifier
// filter in services/error-reports-event.ts.

import { forbiddenCrashNames } from '@/services/crash-name-denylist';

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';
const NAME_MAX = 32;

/** A property or variable name that is source text, not a value that happened to be a key. */
export function isCodeName(name: string): boolean {
  if (name.length === 0 || name.length > NAME_MAX) return false;
  if (!new RegExp(`^${IDENT}$`).test(name)) return false;
  if (/^[A-Z0-9_$]+$/.test(name)) return false; // ETH, FDUSD, USDC: a symbol used as a key
  if (/^pp/i.test(name)) return false; // ppUSDT, ppusdt: a share symbol, whatever the case
  return /^[a-z_$]/.test(name);
}

/**
 * Safe to put in a report: source-text shaped (isCodeName) AND not the name of any
 * token, share, underlying, native currency or chain in the configuration. An
 * unreadable configuration refuses everything rather than reporting more.
 */
export function isReportableName(name: string): boolean {
  if (!isCodeName(name)) return false;
  const forbidden = forbiddenCrashNames();
  return forbidden.size > 0 && !forbidden.has(name.toLowerCase());
}

const dotted = (chain: string): string | null => {
  const parts = chain.split('.');
  return parts.every(isReportableName) ? parts.join('_') : null;
};

const RULES: Array<[RegExp, (m: RegExpExecArray) => string | null]> = [
  [new RegExp(`^Cannot read propert(?:y|ies) of (undefined|null) \\(reading '(${IDENT})'\\)`), (m) => (isReportableName(m[2]) ? `read_${m[1]}_${m[2]}` : null)],
  [new RegExp(`^Cannot set propert(?:y|ies) of (undefined|null) \\(setting '(${IDENT})'\\)`), (m) => (isReportableName(m[2]) ? `set_${m[1]}_${m[2]}` : null)],
  [new RegExp(`^Cannot destructure property '(${IDENT})' of '[^']*' as it is (undefined|null)`), (m) => (isReportableName(m[1]) ? `destructure_${m[2]}_${m[1]}` : null)],
  [new RegExp(`^(${IDENT}(?:\\.${IDENT})*) is not a function`), (m) => { const n = dotted(m[1]); return n ? `notFunction_${n}` : null; }],
  [new RegExp(`^(${IDENT}(?:\\.${IDENT})*) is not iterable`), (m) => { const n = dotted(m[1]); return n ? `notIterable_${n}` : null; }],
  [new RegExp(`^(${IDENT}) is not defined`), (m) => (isReportableName(m[1]) ? `notDefined_${m[1]}` : null)],
  [/^Maximum update depth exceeded/, () => 'maxUpdateDepth'],
  [/^Too many re-renders/, () => 'tooManyRerenders'],
  [/^Rendered (?:more|fewer) hooks than/, () => 'hookCountChanged'],
  [/^Invalid hook call/, () => 'invalidHookCall'],
  [/^Objects are not valid as a React child/, () => 'objectAsChild'],
  [/^Cannot convert undefined or null to object/, () => 'nullToObject'],
  [/^Cannot convert .* to a BigInt/, () => 'toBigInt'],
  [/^Cannot mix BigInt and other types/, () => 'mixBigInt'],
  [/^Maximum call stack size exceeded/, () => 'stackOverflow'],
  [/^Invalid array length/, () => 'invalidArrayLength'],
];

/** The identifier for this message, or undefined when it is not a sentence we recognise. */
export function errorShape(message: unknown): string | undefined {
  if (typeof message !== 'string') return undefined;
  for (const [pattern, build] of RULES) {
    const match = pattern.exec(message.trim());
    if (!match) continue;
    const shape = build(match);
    return shape && shape.length <= 64 && new RegExp(`^${IDENT}$`).test(shape) ? shape : undefined;
  }
  return undefined;
}
