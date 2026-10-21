/**
 * Where a flow failed, why, and from which line of code, in shapes that cannot
 * carry a value.
 *
 * "Deposit operation failed" was the only thing prod could say about a failed
 * deposit, and the 2026-09-16 boolean classes (services/error-reports-cause.ts)
 * only reach a staging session through the gated diagnostic bag. This module
 * adds what a real-money session may also send, and every field follows the
 * rule of services/error-reports-event.ts: CONSTRUCTED from an allowlist, never
 * copied from the error.
 *
 * - `stage` and `reason` are members of fixed enums. The reason is read from
 *   the error's CLASS (its `name`, its numeric `code`, its HTTP `status`, our
 *   own `errorReportReason` tag), walking the `cause` chain. Never its message.
 * - The context is a chain id from the app's own chain list, an asset symbol
 *   from the configured token list, a boolean, and two enums. Anything else
 *   becomes `other` or is dropped.
 * - The stack is re-parsed after the message is cut off, and a frame is kept
 *   only when its file is one of this build's web chunks on the app's own
 *   origin. Function names must be plain identifiers. The exception MESSAGE
 *   is never read for output.
 *
 * Pure and dependency-free so all of it can be tested without a Sentry runtime.
 */

export const ERROR_REPORT_STAGES = Object.freeze([
  'wallet-connect',
  'validate',
  'approve',
  'relayer-check',
  'recipient-check',
  'quote',
  'proof',
  'submit',
  'confirm',
  'unknown',
] as const);
export type ErrorReportStage = (typeof ERROR_REPORT_STAGES)[number];

export const ERROR_REPORT_REASONS = Object.freeze([
  'user-rejected',
  'insufficient-funds',
  'insufficient-gas',
  'timeout',
  'rpc-error',
  'relayer-unavailable',
  'asp-unavailable',
  'revert',
  'unknown',
] as const);
export type ErrorReportReason = (typeof ERROR_REPORT_REASONS)[number];

export const WALLET_KINDS = Object.freeze(['eoa', 'smart', 'passkey', 'unknown'] as const);
export type ErrorReportWalletKind = (typeof WALLET_KINDS)[number];

/**
 * Connector ids we name. wagmi ids, EIP-6963 rdns values of common wallets,
 * and our own two. Anything else is `other`: an rdns is chosen by the wallet
 * vendor, and an unknown one could be a self-built extension unique to one
 * user.
 */
export const KNOWN_CONNECTORS = Object.freeze([
  'injected',
  'metaMask',
  'metaMaskSDK',
  'walletConnect',
  'coinbaseWallet',
  'coinbaseWalletSDK',
  'safe',
  'pools-embedded',
  'pools-passkey-eoa',
  'io.metamask',
  'io.metamask.flask',
  'com.coinbase.wallet',
  'io.rabby',
  'app.phantom',
  'com.trustwallet.app',
  'io.zerion.wallet',
  'com.brave.wallet',
  'me.rainbow',
  'com.okex.wallet',
  'com.bitget.web3',
  'io.xdefi',
  'app.backpack',
  'com.exodus.web3-wallet',
  'io.frame',
  'app.keplr',
] as const);

function isMember<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export function safeStage(value: unknown): ErrorReportStage | undefined {
  return isMember(ERROR_REPORT_STAGES, value) ? value : undefined;
}

export function safeReason(value: unknown): ErrorReportReason | undefined {
  return isMember(ERROR_REPORT_REASONS, value) ? value : undefined;
}

export function safeWalletKind(value: unknown): ErrorReportWalletKind {
  return isMember(WALLET_KINDS, value) ? value : 'unknown';
}

export function safeConnector(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'unknown';
  return isMember(KNOWN_CONNECTORS, value) ? value : 'other';
}

/** A chain id the app itself configures, else nothing. */
export function safeChainId(value: unknown, known: readonly number[] | undefined): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) return undefined;
  return known?.includes(n) ? n : undefined;
}

/** A symbol from the configured token list, else `other`. */
export function safeAssetSymbol(value: unknown, known: readonly string[] | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (!known?.includes(value)) return 'other';
  // The list is ours, but a symbol is still checked for shape before it leaves.
  return /^[A-Za-z0-9.]{1,16}$/.test(value) ? value : 'other';
}

/**
 * The stage names call sites already pass to the staging diagnostic bag,
 * folded onto the enum. Kept here so the free-form strings never travel to
 * prod: only the enum member does.
 */
const STAGE_ALIASES: Readonly<Record<string, ErrorReportStage>> = Object.freeze({
  'evm-submit': 'submit',
  'stellar-broadcast': 'submit',
  'sui-broadcast': 'submit',
  'yield-quote': 'quote',
  'fee-quote': 'quote',
  'swap-quote': 'quote',
  relay: 'submit',
  'batch-partial': 'submit',
  'batch-pre-submit': 'proof',
  'batch-submission-unknown': 'submit',
  'batch-receipt-unknown': 'confirm',
  'batch-reverted': 'confirm',
  'batch-confirmed-sync-failed': 'confirm',
});

/**
 * Stage names that a flow's single catch-all uses for EVERY error it catches.
 * They say only "the submit handler threw", so the phase the flow had reached
 * is the better answer when there is one.
 */
const CATCH_ALL_STAGES: ReadonlySet<string> = new Set(['evm-submit', 'stellar-broadcast', 'sui-broadcast', 'relay']);

/**
 * The enum stage for a report: the call site's explicit stage when it names
 * a specific one, else the phase the flow last entered, else the catch-all
 * stage, else `unknown`.
 */
export function resolveStage(explicit: string | undefined, phase: unknown): ErrorReportStage {
  const known = safeStage(phase);
  if (explicit && CATCH_ALL_STAGES.has(explicit) && known && known !== 'unknown') return known;
  if (explicit) {
    const direct = safeStage(explicit) ?? STAGE_ALIASES[explicit];
    if (direct) return direct;
  }
  return known ?? 'unknown';
}

// --- reason ---------------------------------------------------------------

type ErrorLike = { name?: unknown; code?: unknown; status?: unknown; cause?: unknown; errorReportReason?: unknown };

/** By `name`. viem and the SDK both set `name` explicitly, so it survives minification. */
const REASON_BY_NAME: ReadonlyArray<readonly [ErrorReportReason, RegExp]> = [
  ['user-rejected', /^(UserRejectedRequestError|PasskeyCancelledError|NotAllowedError)$/],
  ['insufficient-funds', /^(InsufficientFundsError|InsufficientTransactValue|InsufficientChangeValueForFee)$/],
  ['insufficient-gas', /^(IntrinsicGasTooLowError|IntrinsicGasTooHighError|FeeCapTooLowError|FeeCapTooHighError|TipAboveFeeCapError|EstimateGasExecutionError)$/],
  ['timeout', /^(TimeoutError|AbortError|WaitForTransactionReceiptTimeoutError|SessionInitTimeoutError|SignatureTimeoutError|PayRelayDeadlineError)$/],
  ['relayer-unavailable', /^(RelayerUnavailableError|RelayerRequestFailed|RelayerRejected|RelayerInteractorBaseError)$/],
  ['asp-unavailable', /^(ASPUnavailable|AspBackoffError|ASPClientBaseError)$/],
  ['revert', /^(ContractFunctionRevertedError|ExecutionRevertedError|ContractFunctionZeroDataError|RawContractError)$/],
  ['rpc-error', /^(HttpRequestError|RpcRequestError|WebSocketRequestError|SocketClosedError|InternalRpcError|InvalidInputRpcError|LimitExceededRpcError|ResourceUnavailableRpcError|TransactionRejectedRpcError|MethodNotSupportedRpcError|UnknownRpcError|ChainDisconnectedError|ProviderDisconnectedError|HTTPRequestFailed|HTTPResponseError|RPCInteractorBaseError|ContractReadError|EventReadError|GetBlockNumberError|WaitForReceiptError)$/],
];

/** By EIP-1193 / JSON-RPC numeric code. */
function reasonFromCode(code: unknown): ErrorReportReason | undefined {
  if (typeof code !== 'number' || !Number.isInteger(code)) return undefined;
  if (code === 4001 || code === 5000 || code === 113) return 'user-rejected';
  if (code === 3) return 'revert';
  if (code <= -32000 && code >= -32700) return 'rpc-error';
  if (code === 4100 || code === 4200 || code === 4900 || code === 4901) return 'rpc-error';
  return undefined;
}

/** By HTTP status: a 5xx, 429 or 408 is a service problem, whatever the service. */
function reasonFromStatus(status: unknown): ErrorReportReason | undefined {
  if (typeof status !== 'number' || !Number.isInteger(status)) return undefined;
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429 || (status >= 500 && status <= 599)) return 'rpc-error';
  return undefined;
}

function reasonOf(error: ErrorLike): ErrorReportReason | undefined {
  const tagged = safeReason(error.errorReportReason);
  if (tagged) return tagged;
  // A timeout status beats the generic HTTP error class that carries it.
  if (reasonFromStatus(error.status) === 'timeout') return 'timeout';
  if (typeof error.name === 'string') {
    for (const [reason, pattern] of REASON_BY_NAME) if (pattern.test(error.name)) return reason;
  }
  return reasonFromCode(error.code) ?? reasonFromStatus(error.status);
}

/**
 * The failure's reason, from its class and shape.
 *
 * Walks the `cause` chain because viem wraps the useful error
 * (ContractFunctionExecutionError > ContractFunctionRevertedError,
 * TransactionExecutionError > UserRejectedRequestError). The INNERMOST
 * recognised class wins, since the wrapper names the call and the inner error
 * names the fault, with one exception: a user rejection anywhere in the chain
 * is the answer, because nothing else happened.
 */
export function classifyReason(error: unknown): ErrorReportReason {
  let found: ErrorReportReason | undefined;
  let node: unknown = error;
  for (let depth = 0; depth < 8 && node && typeof node === 'object'; depth += 1) {
    const reason = reasonOf(node as ErrorLike);
    if (reason === 'user-rejected') return reason;
    if (reason) found = reason;
    node = (node as ErrorLike).cause;
  }
  return found ?? 'unknown';
}

// --- exception type and frames ------------------------------------------------

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/** The error's class name, as a bare identifier, else `Error`. */
export function exceptionType(error: unknown): string {
  if (!error || typeof error !== 'object') return typeof error === 'string' ? 'StringError' : 'UnknownError';
  const name = (error as { name?: unknown }).name;
  if (typeof name === 'string' && IDENTIFIER.test(name) && !HEX_RUN.test(name)) return name;
  const ctor = (error as { constructor?: { name?: unknown } }).constructor?.name;
  if (typeof ctor === 'string' && IDENTIFIER.test(ctor) && !HEX_RUN.test(ctor)) return ctor;
  return 'Error';
}

export type ErrorReportFrame = {
  function: string;
  filename: string;
  abs_path: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
};

/** An address is 40 hex, a hash or commitment 64: no run that long survives anywhere. */
const HEX_RUN = /(?:0x)?[0-9a-fA-F]{32,}/;
/** `name`, `Class.method`, `a.b.c`: identifiers and dots only. */
const FUNCTION_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}(?:\.[A-Za-z_$][A-Za-z0-9_$]{0,63}){0,3}$/;
/**
 * The only frame files kept: a web chunk this build emitted. Expo names them
 * `<name>-<32 hex md5>.js`, split-web-bootstrap `bootstrap-part-<24 hex>.js`.
 * That hash is the build's, the same for every user.
 */
const BUILD_CHUNK = /^\/_expo\/static\/js\/web\/([A-Za-z_][A-Za-z0-9_-]{0,63}?)(?:-[0-9a-f]{32})?\.js$/;
const MAX_FRAMES = 50;

function safeFunctionName(raw: string | undefined): string {
  if (!raw) return '?';
  const name = raw.replace(/^async\s+/, '').replace(/^new\s+/, '').trim();
  if (!FUNCTION_NAME.test(name) || HEX_RUN.test(name)) return '?';
  return name;
}

/**
 * A frame location reduced to a build chunk path, or `undefined` to drop the
 * frame. Kept only when it is http(s) on the app's own origin and the path is
 * one of this build's web chunks: no query, no hash, nothing a user, a
 * message or another site can choose. Local files, extensions, foreign hosts
 * and protocol-relative URLs are all dropped.
 */
function buildChunkPath(raw: string, origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  const location = raw.trim();
  if (!location.startsWith(`${origin}/`)) return undefined;
  if (!/^https?:\/\/[^/]+$/.test(origin)) return undefined;
  const path = location.slice(origin.length).split(/[?#]/, 1)[0] ?? '';
  const match = BUILD_CHUNK.exec(path);
  if (!match || HEX_RUN.test(match[1] ?? '')) return undefined;
  return path;
}

function positive(raw: string | undefined): number | undefined {
  if (!raw || !/^\d{1,7}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n > 0 ? n : undefined;
}

// `    at fn (location:line:col)` / `    at location:line:col` (V8)
const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/;
// `fn@location:line:col` (SpiderMonkey, JavaScriptCore)
const GECKO_FRAME = /^\s*([^@\s]*)@(.+?):(\d+):(\d+)\s*$/;

export type StackSource = {
  /** The error's own message: everything up to its end is never parsed. */
  message?: unknown;
  /** The app's origin, `location.origin`. Without it no frame is kept. */
  origin?: string;
};

/**
 * Frames from `error.stack`, oldest first as Sentry expects.
 *
 * The message is cut off first: a V8 stack starts with `Name: message` and
 * the message may span lines and contain frame-shaped text. Without a known
 * message the first line is skipped. Then a frame is kept only when its file
 * is one of this build's chunks on the app's own origin, and its function a
 * plain identifier (else `?`). Everything else is dropped, so even a frame
 * forged inside a message can only name one of our own chunks.
 */
export function parseStackFrames(stack: unknown, source: StackSource = {}): ErrorReportFrame[] {
  if (typeof stack !== 'string' || stack.length === 0) return [];
  let rest = stack;
  const message = source.message;
  const at = typeof message === 'string' && message.length > 0 ? rest.indexOf(message) : -1;
  if (at !== -1) rest = rest.slice(at + (message as string).length);
  const lines = rest.split('\n').slice(at !== -1 ? 1 : 0, 200);
  const v8 = lines.some((line) => /^\s*at /.test(line));
  // V8 without a known message: the first line is `Name: message`.
  if (at === -1 && v8 && lines.length > 0 && !/^\s*at /.test(lines[0] ?? '')) lines.shift();
  const frames: ErrorReportFrame[] = [];
  for (const line of lines) {
    const match = v8 ? (/^\s*at /.test(line) ? V8_FRAME.exec(line) : null) : GECKO_FRAME.exec(line);
    if (!match) continue;
    const path = buildChunkPath(match[2] ?? '', source.origin);
    if (!path) continue;
    const frame: ErrorReportFrame = {
      function: safeFunctionName(match[1]),
      filename: path,
      abs_path: path,
      in_app: true,
    };
    const lineno = positive(match[3]);
    const colno = positive(match[4]);
    if (lineno !== undefined) frame.lineno = lineno;
    if (colno !== undefined) frame.colno = colno;
    frames.push(frame);
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames.reverse();
}

/** The Stellar session's own stage names, folded onto the enum. */
const STELLAR_STAGES: Readonly<Record<string, ErrorReportStage>> = Object.freeze({
  unlocking: 'wallet-connect',
  registering: 'wallet-connect',
  proving: 'proof',
  signing: 'submit',
  relaying: 'submit',
  confirming: 'confirm',
  'registering-label': 'confirm',
  syncing: 'confirm',
});

export function stellarErrorReportStage(stage: string): ErrorReportStage {
  return STELLAR_STAGES[stage] ?? 'unknown';
}
