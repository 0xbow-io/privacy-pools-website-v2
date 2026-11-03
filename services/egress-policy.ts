/**
 * Fail-closed policy at the app-owned EVM ASP, relayer and RPC HTTP chokepoints.
 * The separate Sui stack, external wallets and other services are outside it.
 *
 * WHY THIS EXISTS
 *
 * Every leak we have shipped was a request nobody reviewed as a request. The
 * 2026-09-10 disclosure was two of them: the user's whole deposit label set in
 * an `X-Labels` HEADER, and the exact withdrawal amount in an amount-keyed
 * query string, re-sent on every value typed. Both were written by someone
 * solving a real product problem, both passed review, and neither reads as a
 * privacy decision at the call site — you have to already be looking for it.
 *
 * A denylist cannot fix that, because a denylist only knows the leaks you have
 * already had. This is an ALLOWLIST: a request to the ASP, an RPC provider or
 * the relayer is refused unless its exact route, its exact query keys and its
 * exact headers are declared here. Adding a new outbound call therefore means
 * editing this file, which is the review moment we did not have.
 *
 * DESIGN RULES
 *
 *  - Unknown route, unknown param, unknown header -> REFUSED. Not warned.
 *  - A route that names one user's data (a label decision, an address filter)
 *    is marked and reachable only by a caller that declares an intent, so it
 *    can never happen as a side effect of a background sync.
 *  - Refusal messages name the ROUTE and the KEY, never the value. A log line
 *    that quotes the leaking value has leaked it to the log.
 *  - This module is pure: no react-native, no config imports, no fetch. It is
 *    a decision function, so it is testable and cannot itself do I/O.
 *
 * This is the runtime half of a pair. `scripts/e2e/network-privacy.ts` proves
 * from observed traffic that a real journey leaked nothing; this refuses the
 * request in the first place. Neither replaces the other: the gate catches
 * what a chokepoint does not see (a request made by a library that goes around
 * it), and the policy catches what a journey did not happen to exercise.
 */

import { decodeFunctionData, multicall3Abi } from 'viem';

export type EgressParty = 'asp' | 'rpc' | 'relayer';

export type EgressRequest = {
  method: string;
  /** Absolute URL, or a path — both are accepted so a client can check early. */
  url: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
};

export type EgressVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * A deliberate, user-visible action that is allowed to name one user.
 *
 * These are not loopholes: each is a case where the user asked for exactly
 * this lookup and the alternative is not offering the feature. They must be
 * passed explicitly at the call site, so a targeted request is written down as
 * a choice instead of inherited from a shared helper.
 */
export type EgressIntent =
  /** The self-report flow. The user is deliberately telling the ASP their address. */
  | 'user-report-address'
  /** The wallet screening check. The user asks whether 0xbow services refuse their own wallet. */
  | 'user-wallet-screening'
  /** Verifying ONE origin proof the user opened. Not reachable from a sync. */
  | 'user-initiated-audit';

export class EgressRefusedError extends Error {
  constructor(
    public party: EgressParty,
    public reason: string,
  ) {
    // Never retain the rejected URL: error reporters also serialize fields.
    super(`Egress refused (${party}): ${reason}`);
    this.name = 'EgressRefusedError';
  }
}

// ---------------------------------------------------------------------------
// Shared value tests
// ---------------------------------------------------------------------------

/**
 * Does this look like a note-derived value rather than a configuration value?
 *
 * 40 hex characters is an address, 64 is a hash or a field element, and a
 * 12+ digit decimal is a wei amount or a decimal-encoded hash. Page numbers,
 * chain ids and block numbers fall below all of these, which is the point: an
 * ordinary paginated feed has to pass, or every route would need an exemption
 * and the exemptions would stop meaning anything.
 */
export function looksHighEntropy(value: string): boolean {
  const v = value.trim();
  if (/^0x[0-9a-fA-F]{40,}$/.test(v)) return true;
  if (/^[0-9a-fA-F]{64}$/.test(v)) return true;
  if (/^\d{12,}$/.test(v)) return true;
  return false;
}

/** Headers any request may carry. Everything else must be declared per route. */
const BASE_HEADERS: Record<string, RegExp> = {
  'content-type': /^application\/json(?:;\s*charset=utf-8)?$/i,
  accept: /^(?:application\/json|\*\/\*)$/i,
};

function checkHeaders(headers: EgressRequest['headers'], extra: string[] = []): EgressVerdict {
  for (const [rawKey, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    const key = rawKey.toLowerCase();
    if (Object.hasOwn(BASE_HEADERS, key) && BASE_HEADERS[key].test(value)) continue;
    if (extra.includes(key) && key === 'x-asset' && isAsset(value)) continue;
    // Even a header NAME can be a secret. Only quote a known regression key.
    return { allowed: false, reason: key === 'x-labels'
      ? "request may not carry the 'x-labels' header"
      : 'request carries an undeclared header or header value' };
  }
  return { allowed: true };
}

const isAddress = (value: string): boolean => /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value);
const isAsset = (value: string): boolean => isAddress(value) || /^0x[0-9a-fA-F]{1,64}::[a-zA-Z_][\w]*::[a-zA-Z_][\w]*$/.test(value);

function validQueryValue(key: string, value: string): boolean {
  switch (key) {
    case 'entrypoint': case 'address': return isAddress(value);
    case 'token': return isAsset(value);
    // A yield share token. Public build configuration, like 'token' — and it
    // MUST be listed here rather than falling through, because the default
    // below only accepts short decimals and would refuse an address.
    case 'asset': return isAsset(value);
    case 'action': return ['deposit', 'withdrawal', 'ragequit', 'transfer'].includes(value);
    case 'status': return ['pending', 'approved', 'declined'].includes(value);
    case 'includeRagequit': return value === 'true' || value === 'false';
    case 'window': return ['7d', '30d', '90d'].includes(value);
    case 'include': return value.split(',').every((v) => ['deposits', 'transacts', 'ragequits', 'leaves', 'keystoreLeaves', 'notes'].includes(v));
    default: return /^\d{1,11}$/.test(value); // page, chain and incremental cursors
  }
}

function checkBody(req: EgressRequest, keys?: readonly string[]): EgressVerdict {
  if (req.body == null) return { allowed: true };
  if (!keys) return { allowed: false, reason: 'this route may not carry a body' };
  let body: unknown;
  try { body = JSON.parse(req.body); } catch {
    return { allowed: false, reason: 'request body is not JSON' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !keys.includes(key))) {
    return { allowed: false, reason: 'request body contains undeclared fields' };
  }
  return { allowed: true };
}

function splitUrl(url: string): { path: string; params: URLSearchParams } {
  // Accept both an absolute URL and a bare path: the ASP client checks before
  // it has prefixed its base URL, the SDK wrapper checks after.
  const u = new URL(url, 'http://egress.invalid');
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) throw new Error('invalid URL');
  return { path: u.pathname, params: u.searchParams };
}

// ---------------------------------------------------------------------------
// ASP
// ---------------------------------------------------------------------------

type AspRoute = {
  method?: 'GET' | 'POST';
  path: RegExp;
  /** Query keys this route may carry. Anything else is refused. */
  params?: string[];
  /**
   * Params allowed to hold a high-entropy value because the value is PUBLIC
   * configuration, not user data: a pool entrypoint, a token contract. Named
   * one by one so a new opaque param cannot be waved through.
   */
  opaqueParams?: string[];
  /** Each targeted param declares its own intents; path intents cannot unlock it. */
  targetedParams?: Record<string, EgressIntent[]>;
  /** Extra headers this route may carry, lowercase. */
  headers?: string[];
  /** The path itself names one user. Requires an intent. */
  targeted?: boolean;
  /**
   * Which intents unlock the targeted path of this route. A list because one
   * route can be reached both by a deliberate user action and by a known gap
   * we have not closed yet, and those must stay distinguishable at the call
   * site rather than collapsing into one permissive flag.
   */
  intents?: EgressIntent[];
  /** Body keys a POST may carry. Defaults to the self-report's SIWE fields plus `reason`. */
  bodyKeys?: readonly string[];
};

/** `{chain}` in a route: a numeric chain id, or the cross-chain pseudo-scopes. */
const CHAIN = String.raw`(?:\d{1,11}|global|all)`;

/**
 * Every ASP route this app is allowed to call.
 *
 * Mirrors services/api-client.ts. Two absences are deliberate and
 * load-bearing:
 *
 *  - the amount-keyed deposit-count route — it has to be told the exact wei
 *    the user is about to withdraw, which is the same integer the on-chain
 *    withdrawal publishes minutes later. Removed 2026-09-10; this list is what
 *    stops it coming back. Count locally against the caller-independent
 *    distribution feed instead, fetched with the other public feeds at load.
 *  - any route that takes a caller's label set — the association set is
 *    downloaded whole and classified locally.
 */
export const ASP_ROUTES: AspRoute[] = [
  { path: new RegExp(`^/${CHAIN}/health/(liveness|asp|leaves)$`) },
  {
    path: /^\/global\/public\/events$/,
    // No `address`: filtering the feed by an account is what tells the ASP
    // which rows are that account's. The account's own older rows are built
    // locally from the event snapshot (services/own-history-rows.ts).
    params: ['page', 'perPage', 'action', 'status', 'chainId', 'token', 'includeRagequit', 'entrypoint'],
    opaqueParams: ['token', 'entrypoint'],
  },
  { path: /^\/global\/public\/statistics$/ },
  { path: new RegExp(`^/${CHAIN}/public/asset-statistics$`), headers: ['x-asset'] },
  { path: /^\/global\/public\/token-prices$/, params: ['chainId'] },
  { path: new RegExp(`^/${CHAIN}/public/assets-stats$`) },
  // The yield feeds behind "yield earned". Both are ASSET-level bulk data: the
  // same bytes go to every client holding that share, which is the only reason
  // an earned figure can be computed without telling the ASP which notes this
  // wallet holds. The 'asset' key is a share token address from build
  // configuration, never anything of the user's; 'sinceId' is the SERVER's own
  // opaque row cursor echoed back, resuming a public log where this client left
  // off.
  //
  // Note what is deliberately absent, because each would make the request a
  // function of the wallet's notes: 'since', 'from', 'fromBlock', 'after', any
  // per-commitment or per-label selector, and any "stop once my oldest note is
  // covered" bound. Adding one here is not a tuning change.
  {
    path: new RegExp(`^/${CHAIN}/public/yield-deposits$`),
    // The whole chain's feed: neither ppv2 nor the SDK filters it by share, so
    // no 'asset' here (egress-policy-coverage derives this set from both).
    params: ['sinceId'],
  },
  // Public keystore registries, consumed by services/viewing-key-cache.ts and
  // services/nullifying-key-hash-cache.ts. 'entrypoint' is the configured pool,
  // selecting its keystore on a chain whose pools use more than one.
  { path: new RegExp(`^/${CHAIN}/public/viewing-keys$`), params: ['sinceId', 'entrypoint'], opaqueParams: ['entrypoint'] },
  { path: new RegExp(`^/${CHAIN}/public/nullifying-key-hashes$`), params: ['sinceId', 'entrypoint'], opaqueParams: ['entrypoint'] },
  {
    path: new RegExp(`^/${CHAIN}/public/ppusdc-rate-history$`),
    params: ['asset', 'sinceId'],
    opaqueParams: ['asset'],
  },
  // 'window' is pinned by the caller to a build constant (ppv2 GRID_APY_WINDOW),
  // never the user's chart selection.
  {
    path: new RegExp(`^/${CHAIN}/public/ppusdc-vault-metrics$`),
    params: ['asset', 'window'],
    opaqueParams: ['asset'],
  },
  { path: /^\/global\/public\/entrypoints$/ },
  {
    path: /^\/global\/public\/report-address\/nonce$/,
    params: ['address'],
    targetedParams: { address: ['user-report-address'] },
    targeted: true,
    intents: ['user-report-address'],
  },
  {
    method: 'POST',
    path: /^\/global\/public\/report-address$/,
    targeted: true,
    intents: ['user-report-address'],
  },
  {
    path: /^\/global\/public\/screening\/nonce$/,
    params: ['address'],
    targetedParams: { address: ['user-wallet-screening'] },
    targeted: true,
    intents: ['user-wallet-screening'],
  },
  {
    method: 'POST',
    path: /^\/global\/public\/screening\/check$/,
    targeted: true,
    intents: ['user-wallet-screening'],
    // The SIWE proof and nothing else: no free-text field rides along.
    bodyKeys: ['address', 'nonce', 'message', 'signature'],
  },
  { path: /^\/association-set\/root$/, params: ['chainId', 'entrypoint'], opaqueParams: ['entrypoint'] },
  { path: /^\/association-set\/leaves$/, params: ['chainId', 'entrypoint'], opaqueParams: ['entrypoint'] },
  // Legacy pool: /association-set/{mtId}/leaves. The id is a small integer
  // naming a pool, not a user.
  { path: /^\/association-set\/\d+\/leaves$/ },
  { path: /^\/labels\/(rejected|poi-required)$/, params: ['chainId', 'entrypoint'], opaqueParams: ['entrypoint'] },
  {
    // One label's decision. This is the per-note lookup the whole exercise is
    // about: the bulk decisions and association-set leaves classify
    // every label locally, so nothing on a sync path needs this.
    path: /^\/labels\/[^/]+\/status$/,
    params: ['chainId', 'entrypoint'],
    opaqueParams: ['entrypoint'],
    targeted: true,
    intents: ['user-initiated-audit'],
  },
  { path: /^\/public-key$/ },
  {
    // The SDK's Note-event fast path. `since`/`until` are BLOCK NUMBERS, not
    // note values — but they are still this client's sync progress, which is a
    // weak fingerprint across sessions. Aligned to a grid by
    // services/log-scan-alignment.ts so every client asking at the same height
    // sends the same number.
    path: new RegExp(`^/${CHAIN}/public/note-events$`),
    params: ['since', 'until', 'entrypoint'],
    opaqueParams: ['entrypoint'],
  },
  { path: new RegExp(`^/${CHAIN}/public/event-snapshot/latest$`), params: ['entrypoint'], opaqueParams: ['entrypoint'] },
  {
    path: new RegExp(`^/${CHAIN}/public/event-snapshot/payload$`),
    params: ['include', 'sinceBlock', 'entrypoint'],
    opaqueParams: ['entrypoint'],
  },
  // Points: the published epochs and each epoch's whole rate table. Pool-level
  // parameters, identical for every client; a balance is computed locally from
  // them. 'sinceId' is the server's own row cursor. No route here may take a
  // commitment, nullifier, label or address.
  {
    path: new RegExp(`^/${CHAIN}/public/points/epochs$`),
    params: ['sinceId', 'entrypoint'],
    opaqueParams: ['entrypoint'],
  },
  {
    path: new RegExp(`^/${CHAIN}/public/points/epochs/\\d{1,20}/rate-leaves$`),
    params: ['entrypoint'],
    opaqueParams: ['entrypoint'],
  },
];

export function checkAspRequest(req: EgressRequest, intent?: EgressIntent): EgressVerdict {
  let path: string;
  let params: URLSearchParams;
  try {
    ({ path, params } = splitUrl(req.url));
  } catch {
    return { allowed: false, reason: 'unparseable URL' };
  }

  const method = (req.method || 'GET').toUpperCase();
  const route = ASP_ROUTES.find((r) => r.path.test(path) && (r.method ?? 'GET') === method);
  if (!route) {
    return {
      allowed: false,
      reason:
        'request is not a declared ASP route. Add it to ASP_ROUTES in '
        + 'services/egress-policy.ts, and say there what the ASP learns from it.',
    };
  }

  // Diagnostics use the declared pattern, never a user-supplied path segment.
  path = route.path.source;
  const unlocks = (declared?: EgressIntent[]): boolean =>
    intent !== undefined && (declared ?? []).includes(intent);

  if (route.targeted && !unlocks(route.intents)) {
    return {
      allowed: false,
      reason:
        `${path} names one user's data and may only be called with one of `
        + `[${(route.intents ?? []).join(', ')}]. A background sync must use the bulk feeds instead.`,
    };
  }

  const allowedParams = new Set(route.params ?? []);
  const opaque = new Set(route.opaqueParams ?? []);
  const targetedParams = route.targetedParams ?? {};
  const seen = new Set<string>();
  for (const [key, value] of params.entries()) {
    if (!allowedParams.has(key)) {
      return { allowed: false, reason: `${path} carries an undeclared query parameter` };
    }
    if (seen.has(key)) return { allowed: false, reason: `${path} repeats a query parameter` };
    seen.add(key);
    if (targetedParams[key] && !unlocks(targetedParams[key])) {
      return {
        allowed: false,
        reason:
          `${path}?${key}= names one user and may only be sent with one of `
          + `[${targetedParams[key].join(', ')}]`,
      };
    }
    if (!opaque.has(key) && !targetedParams[key] && looksHighEntropy(value)) {
      return {
        allowed: false,
        reason:
          `${path}?${key}= carries a high-entropy value. If it is public `
          + "configuration, list it in that route's opaqueParams and say why.",
      };
    }
    if (!validQueryValue(key, value)) return { allowed: false, reason: `${path} has an invalid ${key} value` };
  }

  const headerVerdict = checkHeaders(req.headers, route.headers);
  if (!headerVerdict.allowed) return headerVerdict;
  return checkBody(req, method === 'POST' ? route.bodyKeys ?? ['address', 'nonce', 'message', 'signature', 'reason'] : undefined);
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

/**
 * JSON-RPC methods a client of ours may call.
 *
 * An RPC provider sees a public chain, so the danger is not the method but the
 * ARGUMENT: asking it about one note tells it that note is interesting to this
 * IP, and it sees the same value on-chain shortly after.
 */
const RPC_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getBalance',
  'eth_getCode',
  'eth_call',
  'eth_estimateGas',
  // viem 2.45 local-account transaction preparation probes this before fallback.
  'eth_fillTransaction',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getTransactionCount',
  'eth_sendRawTransaction',
  'eth_getTransactionReceipt',
  'eth_getTransactionByHash',
  'eth_getLogs',
  'net_version',
  'web3_clientVersion',
]);

/**
 * `eth_call` selectors that take a note identifier as their only argument.
 *
 * The vault's per-note existence and per-note spent lookups answer "does this
 * note exist" and "has it been spent". One call names one note. The bulk
 * replacement is services/onchain-note-index.ts, which derives the same
 * answers from event ranges nobody can attribute to a caller.
 *
 * Selectors rather than names because that is what is on the wire: a caller
 * hand-rolling the calldata would sail past a name check.
 */
export const FORBIDDEN_CALL_SELECTORS: Record<string, string> = {
  '0x49ce8997': 'per-note existence lookup (uint256)',
  '0x811608fd': 'per-note spent lookup (uint256)',
  '0x839df945': 'per-note existence lookup (bytes32)',
  '0x1c70406a': 'per-note spent lookup (bytes32)',
};

type JsonRpcCall = { method?: unknown; params?: unknown };

export function checkRpcRequest(req: EgressRequest): EgressVerdict {
  const headers = checkHeaders(req.headers);
  if (!headers.allowed) return headers;
  if (req.method.toUpperCase() !== 'POST' || !req.body) {
    return { allowed: false, reason: 'RPC requires POST with a JSON-RPC body' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body);
  } catch {
    return { allowed: false, reason: 'RPC body is not JSON' };
  }
  if (Array.isArray(parsed) && parsed.length === 0) return { allowed: false, reason: 'empty RPC batch' };
  const calls: JsonRpcCall[] = Array.isArray(parsed)
    ? (parsed as JsonRpcCall[])
    : [parsed as JsonRpcCall];
  // A batch is refused as a whole: one forbidden call in it is still that call.
  for (const call of calls) {
    const verdict = checkRpcCall(call);
    if (!verdict.allowed) return verdict;
  }
  return { allowed: true };
}

function checkRpcCall(call: JsonRpcCall): EgressVerdict {
  if (!call || typeof call !== 'object' || Array.isArray(call)) return { allowed: false, reason: 'invalid JSON-RPC call' };
  if (Object.keys(call).some((key) => !['jsonrpc', 'id', 'method', 'params'].includes(key))) return { allowed: false, reason: 'undeclared JSON-RPC envelope field' };
  if (call.params !== undefined && !Array.isArray(call.params)) return { allowed: false, reason: 'invalid JSON-RPC params' };
  const method = typeof call.method === 'string' ? call.method : '';
  if (!RPC_METHODS.has(method)) {
    return { allowed: false, reason: 'request is not a declared JSON-RPC method' };
  }
  const params = Array.isArray(call.params) ? call.params : [];
  if (['eth_chainId', 'eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'net_version', 'web3_clientVersion'].includes(method) && params.length) return { allowed: false, reason: 'unexpected JSON-RPC params' };

  if (['eth_call', 'eth_estimateGas', 'eth_fillTransaction'].includes(method)) {
    const tx = params[0] as { data?: unknown; input?: unknown } | undefined;
    // Check both aliases; a provider may prefer input when both are supplied.
    for (const data of [tx?.data, tx?.input]) {
      if (typeof data !== 'string') continue;
      const verdict = checkCalldata(data);
      if (!verdict.allowed) return verdict;
    }
  }

  if (method === 'eth_getLogs') {
    const filter = params[0] as { topics?: unknown } | undefined;
    const topics = Array.isArray(filter?.topics) ? (filter as { topics: unknown[] }).topics : [];
    // topics[0] is the event signature and identifies nothing about us.
    // topics[1..] filter by an INDEXED value, and filtering the chain by a
    // value only we know is the same leak as asking about it directly.
    for (let i = 1; i < topics.length; i += 1) {
      const t = topics[i];
      if (t === null || t === undefined) continue;
      const values = Array.isArray(t) ? t : [t];
      if (values.some((v) => typeof v === 'string' && looksHighEntropy(v))) {
        return {
          allowed: false,
          reason:
            `eth_getLogs filters on indexed topic ${i}. Fetch the range and filter `
            + 'locally: a server-side topic filter tells the provider which value you hold.',
        };
      }
    }
  }

  return { allowed: true };
}

// viem/wagmi readContracts bundles reads into aggregate3 eth_call calldata.
// Checking only its outer selector would let the original note lookup through.
function checkCalldata(data: string, depth = 0): EgressVerdict {
  if (depth > 16) return { allowed: false, reason: 'RPC multicall nesting limit exceeded' };
  const selector = data.slice(0, 10).toLowerCase();
  const named = FORBIDDEN_CALL_SELECTORS[selector];
  if (named) return { allowed: false, reason: `RPC call is a ${named} and names one note. Use services/onchain-note-index.ts.` };
  if (selector === '0x82ad56cb') {
    try {
      const { args, functionName } = decodeFunctionData({ abi: multicall3Abi, data: data as `0x${string}` });
      if (functionName !== 'aggregate3') return { allowed: false, reason: 'unexpected RPC multicall function' };
      for (const call of args[0]) {
        const verdict = checkCalldata(call.callData, depth + 1);
        if (!verdict.allowed) return verdict;
      }
    } catch {
      return { allowed: false, reason: 'RPC multicall calldata is not decodable' };
    }
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Relayer
// ---------------------------------------------------------------------------

/**
 * The relayer is the one party that is SUPPOSED to see the withdrawal: the
 * amount, the recipient and the proof ARE the request. What it must never see
 * is anything about the notes we did not spend, or where a note came from.
 *
 * ── READ THIS BEFORE EDITING ANY FIELD LIST BELOW ────────────────────────────
 *
 * These lists are FAIL-CLOSED. An undeclared field is not stripped, the request
 * is REFUSED, and prod runs in enforce. So a field missing from this table is a
 * user-visible outage on whichever flow owns it, not a log line.
 *
 * It has happened: on 2026-09-22 the SDK's `WithdrawalRelayParamsSchema` carried
 * `processorAddress` and `minUnderlyingOut` and these lists declared neither, so
 * EVERY withdrawal failed with "request body contains undeclared fields" the day
 * the policy went to enforce. ppETH and ppUSDC are the open pools, so no path
 * was unaffected and retrying could not help.
 *
 * Note what that means: the change that breaks this table is usually NOT an edit
 * to this file. It is a re-vendored SDK that grew a field. Run
 * `services/__tests__/egress-policy-coverage.test.ts` after vendoring; it reads
 * the field names out of the SDK's own zod declarations and puts them through
 * this policy. Its expectations must stay DERIVED: the same test missed the
 * outage above while its expected names were hand-copied from those schemas with
 * the same omissions, so the test and the policy agreed and were both wrong.
 *
 * A field may be declared only when it is build configuration, a number, or an
 * address the chain already sees. Never declare anything derived from a note: a
 * commitment, a nullifier, a label, a relayed tx hash. If the SDK wants to send
 * one of those, the fix is upstream, not a wider list here.
 */
const QUOTE_FIELDS = ['asset', 'amount', 'commit'];
const RELAY_FIELDS = ['proof', 'noteData', 'signedFeeCommitment', 'inputNullifierNumber', 'outputCommitmentNumber'];
/**
 * The yield-withdrawal routing on top of a plain relay, from the SDK's
 * `WithdrawalRelayParamsSchema`: `processorAddress` is the PPRouter the relayer
 * calls `withdrawToUnderlying` on, `minUnderlyingOut` the slippage floor.
 *
 * Both are build configuration and a number, not anything derived from a note,
 * which is why they may be declared rather than removed. Leaving them out
 * refused every relayed withdrawal from a share pool the moment the policy went
 * to enforce, and since ppETH and ppUSDC ARE the open pools, that is every
 * withdrawal: "Egress refused (relayer): request body contains undeclared
 * fields", for everyone, with retrying no help.
 *
 * `transfer` keeps the plain set: its schema is `RelayParamsSchema` unextended
 * and it cannot carry these.
 */
const YIELD_RELAY_FIELDS = ['processorAddress', 'minUnderlyingOut'];
/**
 * `${relayer.url}/v1/{quote,relay}/${chainType}/${chainId}/...`. Both chain
 * types are real: config/chains.ts carries `evm` and `sui` entries, and
 * hardcoding `evm` refused every Sui relay.
 */
const RELAYER_CHAIN = String.raw`(evm|sui)\/\d+`;

export const RELAYER_ROUTES: { method: 'GET' | 'POST'; path: RegExp; bodyKeys?: string[] }[] = [
  { method: 'GET', path: /^\/v1\/details$/ },
  // Per-chain details (SDK 4567778d getChainDetails, and services/relayer-details.ts):
  // the relayer's contracts, processors and yield wrappers. A chain id only.
  { method: 'GET', path: new RegExp(`^\\/v1\\/details\\/${RELAYER_CHAIN}$`) },
  // Quotes. Every one of these is built by RelayerInteractor in the VENDORED
  // SDK build; the list is re-derived from node_modules by the coverage test,
  // not maintained by hand, because an earlier version of this table was
  // written against a different build that happened to be installed at the
  // time and was missing six of the ten relayer routes below.
  { method: 'POST', path: new RegExp(`^\\/v1\\/quote\\/${RELAYER_CHAIN}\\/transfer$`), bodyKeys: QUOTE_FIELDS },
  { method: 'POST', path: new RegExp(`^\\/v1\\/quote\\/${RELAYER_CHAIN}\\/receive$`), bodyKeys: [...QUOTE_FIELDS, 'recipient', 'extraGas'] },
  { method: 'POST', path: new RegExp(`^\\/v1\\/quote\\/${RELAYER_CHAIN}\\/batch$`), bodyKeys: ['asset', 'commit', 'recipient', 'extraGas', 'amounts'] },
  {
    method: 'POST',
    path: new RegExp(`^\\/v1\\/quote\\/${RELAYER_CHAIN}\\/swap$`),
    bodyKeys: [
      ...QUOTE_FIELDS, 'recipient', 'fallbackAddress', 'outputToken', 'minOutputAmount', 'extraGas',
      'swapCalldata', 'swapTarget', 'approvalAddress', 'swapValue', 'gasSwapMaxInput',
      'gasSwapCalldata', 'dustRecipient',
      // SDK swapQuoteParamsSchema (v2-monorepo#439): the dust-rescue opt-in is
      // bound into the signed routing at quote time. Same object relay-swap
      // already carries: destination chain id/type, output token, and the
      // account's own stealth identifier. Nothing in it names a note.
      'dustRescue',
    ],
  },
  // Relays.
  { method: 'POST', path: new RegExp(`^\\/v1\\/relay\\/${RELAYER_CHAIN}\\/transfer$`), bodyKeys: RELAY_FIELDS },
  { method: 'POST', path: new RegExp(`^\\/v1\\/relay\\/${RELAYER_CHAIN}\\/withdrawal$`), bodyKeys: [...RELAY_FIELDS, ...YIELD_RELAY_FIELDS] },
  { method: 'POST', path: new RegExp(`^\\/v1\\/relay\\/${RELAYER_CHAIN}\\/register-and-withdrawal$`), bodyKeys: [...RELAY_FIELDS, ...YIELD_RELAY_FIELDS, 'registration'] },
  { method: 'POST', path: new RegExp(`^\\/v1\\/relay\\/${RELAYER_CHAIN}\\/relay-and-announce$`), bodyKeys: [...RELAY_FIELDS, ...YIELD_RELAY_FIELDS, 'announcement'] },
  {
    method: 'POST',
    path: new RegExp(`^\\/v1\\/relay\\/${RELAYER_CHAIN}\\/relay-swap$`),
    bodyKeys: ['proof', 'noteData', 'signedSwapCommitment', 'inputNullifierNumber', 'outputCommitmentNumber'],
  },
  { method: 'POST', path: new RegExp(`^\\/v1\\/relay\\/${RELAYER_CHAIN}\\/batch$`), bodyKeys: ['items', 'signedBatchFeeCommitment'] },
];

export function checkRelayerRequest(req: EgressRequest): EgressVerdict {
  let path: string;
  let params: URLSearchParams;
  try {
    ({ path, params } = splitUrl(req.url));
  } catch {
    return { allowed: false, reason: 'unparseable URL' };
  }
  const route = RELAYER_ROUTES.find((r) => r.path.test(path) && r.method === req.method.toUpperCase());
  if (!route) return { allowed: false, reason: 'request is not a declared relayer route' };
  if (params.size) return { allowed: false, reason: 'relayer route may not carry query parameters' };
  const headers = checkHeaders(req.headers);
  if (!headers.allowed) return headers;
  return checkBody(req, route.bodyKeys);
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

export type EgressMode = 'enforce' | 'report';

/**
 * SHIPS IN REPORT MODE. Set `EXPO_PUBLIC_EGRESS_POLICY=enforce` to fail closed.
 *
 * Say the cost out loud, because it is easy to read "report" as "safe": in
 * report mode a request the policy would have REFUSED is still sent. The
 * refusal becomes a console warning and a Sentry event
 * (services/error-reports.ts), and the bytes go out anyway.
 *
 * That is the deliberate trade for the first deployment (Pat, 2026-09-11).
 * The route table was written by reading this codebase, and a route it does
 * not know about is far more likely to be one nobody thought to declare than
 * an actual leak; enforcing on day one turns every such miss into a broken
 * screen. Codex already found two undeclared SDK routes during review, which
 * is the evidence for that risk rather than a guess about it.
 *
 * The plan is to flip this to `enforce` once a week of real traffic has
 * produced no refusals we did not expect. Until then, the value is that we
 * FIND OUT: a policy that only reports is a comment, but a comment nobody
 * reads and a comment that pages you are different things.
 */
let mode: EgressMode = process.env.EXPO_PUBLIC_EGRESS_POLICY === 'enforce' ? 'enforce' : 'report';

export function setEgressMode(next: EgressMode): void {
  mode = next === 'report' ? 'report' : 'enforce';
}

export function getEgressMode(): EgressMode {
  return mode;
}

type Listener = (party: EgressParty, reason: string) => void;
const listeners = new Set<Listener>();

/**
 * Observe refusals. The callback receives the ROUTE-level reason only, never
 * the value: a refusal forwarded to an error reporter with the value attached
 * would hand it to a third party, which is the thing being prevented.
 */
export function onEgressRefusal(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function checkEgress(
  party: EgressParty,
  req: EgressRequest,
  intent?: EgressIntent,
): EgressVerdict {
  switch (party) {
    case 'asp':
      return checkAspRequest(req, intent);
    case 'rpc':
      return checkRpcRequest(req);
    case 'relayer':
      return checkRelayerRequest(req);
    default:
      return { allowed: false, reason: 'unknown egress party' };
  }
}

/**
 * Throw unless the request is allowed. The chokepoints call this; nothing else
 * should need to.
 */
export function assertEgressAllowed(
  party: EgressParty,
  req: EgressRequest,
  intent?: EgressIntent,
): void {
  const verdict = checkEgress(party, req, intent);
  if (verdict.allowed) return;
  for (const fn of listeners) {
    try {
      fn(party, verdict.reason);
    } catch {
      /* a listener must never be able to suppress the refusal */
    }
  }
  console.warn(`[egress] refused (${party}): ${verdict.reason}`);
  if (mode === 'enforce') throw new EgressRefusedError(party, verdict.reason);
}
