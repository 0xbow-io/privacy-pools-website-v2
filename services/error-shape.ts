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
// only when it looks like a code name: a bare identifier that starts lowercase,
// is not ALL CAPS (a token symbol used as a key) and is not a share symbol. That
// is conservative on purpose. Anything unrecognised is not reported, which costs
// a hint and never leaks. The result always passes the code-identifier filter in
// services/error-reports-event.ts.

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';
const NAME_MAX = 32;

/** A property or variable name that is source text, not a value that happened to be a key. */
export function isCodeName(name: string): boolean {
  if (name.length === 0 || name.length > NAME_MAX) return false;
  if (!new RegExp(`^${IDENT}$`).test(name)) return false;
  if (/^[A-Z0-9_$]+$/.test(name)) return false; // ETH, FDUSD, USDC: a symbol used as a key
  if (/^pp[A-Z]/.test(name)) return false; // ppUSDT: a share symbol
  return /^[a-z_$]/.test(name);
}

const dotted = (chain: string): string | null => {
  const parts = chain.split('.');
  return parts.every(isCodeName) ? parts.join('_') : null;
};

const RULES: Array<[RegExp, (m: RegExpExecArray) => string | null]> = [
  [new RegExp(`^Cannot read propert(?:y|ies) of (undefined|null) \\(reading '(${IDENT})'\\)`), (m) => (isCodeName(m[2]) ? `read_${m[1]}_${m[2]}` : null)],
  [new RegExp(`^Cannot set propert(?:y|ies) of (undefined|null) \\(setting '(${IDENT})'\\)`), (m) => (isCodeName(m[2]) ? `set_${m[1]}_${m[2]}` : null)],
  [new RegExp(`^Cannot destructure property '(${IDENT})' of '[^']*' as it is (undefined|null)`), (m) => (isCodeName(m[1]) ? `destructure_${m[2]}_${m[1]}` : null)],
  [new RegExp(`^(${IDENT}(?:\\.${IDENT})*) is not a function`), (m) => { const n = dotted(m[1]); return n ? `notFunction_${n}` : null; }],
  [new RegExp(`^(${IDENT}(?:\\.${IDENT})*) is not iterable`), (m) => { const n = dotted(m[1]); return n ? `notIterable_${n}` : null; }],
  [new RegExp(`^(${IDENT}) is not defined`), (m) => (isCodeName(m[1]) ? `notDefined_${m[1]}` : null)],
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
