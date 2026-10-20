/**
 * eth_getLogs block-window planning — PURE module (no SDK / react-native
 * imports) so it can be unit-tested directly.
 *
 * Every provider caps how wide a single `eth_getLogs` query may be, and the
 * caps differ by an order of magnitude: Alchemy/Infura allow 10k blocks,
 * Citrea's public RPC only 1000. Past the cap the request FAILS (it is not
 * truncated), so a too-wide window breaks the state-leaf scan that every
 * withdrawal runs:
 *
 *   Withdrawal failed: Contract call failed: Event log fetch failed:
 *   Invalid parameters were provided to the RPC method.
 *   Details: query exceeds max block range 1000
 *
 * `sweepLogRange` walks a range in capped windows, retries rate limits, and
 * narrows the window when a provider rejects one anyway.
 *
 * The SDK's ViemRPCInteractor has its own chunk-and-bisect
 * (`getLogsPaginated`), but the app's wrapper in services/sdk-setup.ts calls
 * the plain `getLogs` because it owns the ASP fast path and the per-session
 * log cache. Window policy therefore lives here, in one place, rather than
 * split across the two layers.
 */

/**
 * Default window as an INCLUSIVE BLOCK COUNT: a window of N blocks is the
 * range [from, from + N - 1], i.e. `toBlock - fromBlock === N - 1`. 10k is
 * what Alchemy and Infura allow; chains that cap tighter declare their own
 * via `logsMaxBlockRange` in config/chains.ts.
 */
export const DEFAULT_MAX_BLOCK_RANGE = 10_000n;

/**
 * How many times one sweep may narrow its window before giving up and
 * rethrowing. A provider that names its cap needs one; halving from 10k to
 * under the tightest cap seen in the wild (Citrea's 1000) needs four. Past
 * that the error is not really about the window, and continuing would keep
 * re-walking rejected windows at ever smaller sizes — hundreds of doomed
 * requests instead of one propagated failure. Chains needing a window below
 * ~150 blocks should configure `logsMaxBlockRange` rather than rely on this.
 */
const MAX_SHRINKS_PER_SWEEP = 6;

/** Matches the SDK's own rate-limit policy (dist: MAX_RATE_LIMIT_RETRIES). */
const MAX_RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = 1_000;

// A public endpoint may serve the head and logs from different backends. Give
// the log backend up to one Ethereum block interval to catch up (2 + 4 + 6s).
// Never clamp the range: callers commit its end as their completed cursor.
const MAX_HEAD_LAG_RETRIES = 3;
const HEAD_LAG_BACKOFF_MS = 2_000;

// How far down an error's `cause` chain to look. The SDK's EventReadError
// wraps the viem error, which wraps the transport error.
const MAX_CAUSE_DEPTH = 4;

function errorText(err: unknown): string {
  // The pool session hands some errors around as plain strings.
  if (typeof err === 'string') return err.toLowerCase();
  const parts: string[] = [];
  for (let e: unknown = err, depth = 0; e != null && depth < MAX_CAUSE_DEPTH; depth++) {
    const { message, details, cause } = e as {
      message?: unknown;
      details?: unknown;
      cause?: unknown;
    };
    if (typeof message === 'string') parts.push(message);
    if (typeof details === 'string') parts.push(details);
    e = cause;
  }
  return parts.join(' ').toLowerCase();
}

// The window was wider than the provider's BLOCK-RANGE limit — a property of
// the provider, so the narrower window is worth keeping for later calls:
//   Citrea    query exceeds max block range 1000
//   Alchemy   block range is too wide
//   Ankr      block range is too large
//   QuickNode eth_getLogs is limited to a 10000 range
const RANGE_CAP_PATTERNS = [
  /block[\s_-]?range/,
  /too many blocks/,
  /limited to .{0,24}(?:block|range)/,
];

// The window matched more logs than the provider will return — a property of
// how DENSE that particular region is, not of the provider's block-range
// limit, so this narrowing must not outlive the window that hit it:
//   Infura    query returned more than 10000 results
//   Alchemy   Log response size exceeded
const RESPONSE_VOLUME_PATTERNS = [
  /query returned more than/,
  /response size (?:exceeded|is larger)/,
  /too many (?:logs|results)/,
];

// The node has not reached the requested block yet; this is not a range cap.
function isHeadLagError(err: unknown): boolean {
  return /(?:block range extends beyond current head block|(?:requested |to )?block (?:number )?is (?:greater|higher) than (?:the )?(?:current |latest )?(?:head|block))/.test(errorText(err));
}

/**
 * Why a window was rejected, or null when a smaller window would not help.
 *
 * Classification is by MESSAGE, not by error class. The classes providers
 * use here (viem's `InvalidParamsRpcError` -32602 for Alchemy/Citrea,
 * `LimitExceededRpcError` -32005 for Infura) are generic buckets that also
 * carry malformed-param and quota errors — publicnode answers a plain
 * `-32602 "Archive requests require a personal token"` — and misclassifying
 * one of those is expensive: the rejected window gets re-walked at a smaller
 * size, so a wrong "yes" turns one failed request into many.
 *
 * A genuine cap error whose wording we don't recognise therefore propagates
 * instead of being shrunk around. That is what `logsMaxBlockRange` in
 * config/chains.ts is for; this shrink is only a safety net.
 */
export function classifyLimitError(err: unknown): 'range' | 'volume' | null {
  // This contains "block range", but narrowing cannot make a future block exist.
  if (isHeadLagError(err)) return null;
  const text = errorText(err);
  if (RANGE_CAP_PATTERNS.some((p) => p.test(text))) return 'range';
  if (RESPONSE_VOLUME_PATTERNS.some((p) => p.test(text))) return 'volume';
  return null;
}

/** True when a smaller window is worth trying. See {@link classifyLimitError}. */
export function isRangeLimitError(err: unknown): boolean {
  return classifyLimitError(err) !== null;
}

/** True for HTTP 429 — retry the same window after a wait, don't narrow it. */
export function isRateLimitError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e != null && depth < MAX_CAUSE_DEPTH; depth++) {
    if ((e as { status?: unknown }).status === 429) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return /\b429\b|too many requests|rate ?limit/.test(errorText(err));
}

/**
 * Reads the cap out of the provider's message ("query exceeds max block
 * range 1000", "max_block_range: 500") so we converge in one step instead
 * of halving repeatedly. Null when the phrasing carries no number — the
 * caller then halves.
 */
export function parseBlockRangeCap(err: unknown): bigint | null {
  const match = /max(?:imum)?[\s_-]+block[\s_-]+range(?:\s+(?:is|of|to))?\s*[:=]?\s*(\d+)/i.exec(
    errorText(err),
  );
  if (!match) return null;
  const cap = BigInt(match[1]);
  return cap > 0n ? cap : null;
}

/**
 * Window size shared by every sweep on one chain, so a cap learned during a
 * withdrawal is still known during the next note scan. Only ever shrinks,
 * and only for block-range caps (see {@link classifyLimitError}).
 */
export type RangeWindow = { maxRange: bigint };

/**
 * The window a chain keeps when the user replaces its endpoints with their own.
 * A preset window wider than the default was probed on OUR provider (Alchemy
 * takes 2M blocks), not theirs, so it falls back to the default. Tighter
 * presets (Citrea 1000) are a property of the chain and stay.
 */
export function windowForCustomEndpoint(preset?: bigint): bigint | undefined {
  return preset != null && preset <= DEFAULT_MAX_BLOCK_RANGE ? preset : undefined;
}

export function createRangeWindow(maxRange?: bigint): RangeWindow {
  return { maxRange: maxRange != null && maxRange > 0n ? maxRange : DEFAULT_MAX_BLOCK_RANGE };
}

export interface SweepOptions<T> {
  /** One eth_getLogs call over the inclusive range [from, to]. */
  fetch: (from: bigint, to: bigint) => Promise<T[]>;
  from: bigint;
  to: bigint;
  /** Window size, narrowed in place when a provider rejects a window. */
  window: RangeWindow;
  /** Called once per narrowing, for logging. */
  onShrink?: (rejectedSpan: bigint, newMaxRange: bigint) => void;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

/** Per-sweep mutable state: shrink budget and the local (volume) window. */
type SweepState = { shrinks: number };

/**
 * Walks the inclusive range [from, to] in `window.maxRange`-sized windows,
 * concatenating the results in ascending block order. Returns [] when the
 * range is empty (`to < from`), issuing no calls.
 *
 * A rejected window is narrowed — to the cap named in the error when it
 * names one, else halved — and re-walked at the new size. HTTP 429 retries
 * the same window with linear backoff. Anything else, a one-block window
 * that still fails, or more than {@link MAX_SHRINKS_PER_SWEEP} narrowings
 * propagates to the caller.
 */
export async function sweepLogRange<T>(opts: SweepOptions<T>): Promise<T[]> {
  const out: T[] = [];
  const state: SweepState = { shrinks: 0 };
  let cursor = opts.from;
  while (cursor <= opts.to) {
    const end = min(cursor + opts.window.maxRange - 1n, opts.to);
    await fetchRange(opts, cursor, end, out, state);
    cursor = end + 1n;
  }
  return out;
}

async function fetchRange<T>(
  opts: SweepOptions<T>,
  start: bigint,
  end: bigint,
  out: T[],
  state: SweepState,
  volumeDepth = 0,
): Promise<void> {
  try {
    const logs = await fetchWithRetry(opts, start, end);
    // Not `out.push(...logs)`: a wide window over a busy pool can return
    // enough logs to blow the argument limit (RangeError).
    for (const log of logs) out.push(log);
    return;
  } catch (err) {
    const kind = classifyLimitError(err);
    if (kind == null || end <= start) throw err;

    const span = end - start + 1n;
    const cap = kind === 'range' ? parseBlockRangeCap(err) : null;
    // `span - 1n` guarantees progress even when the provider names a cap
    // equal to the span it just rejected (off-by-one, or range-vs-count
    // units). span >= 2 here, so the result is always >= 1 and < span.
    // A wide preset window (2M on Alchemy) rejected without a named cap drops
    // straight to the default before halving, so the shrink budget still
    // reaches the narrow caps it reached when windows started at 10k.
    const smaller = cap != null
      ? min(cap, span - 1n)
      : kind === 'range' && span > DEFAULT_MAX_BLOCK_RANGE ? DEFAULT_MAX_BLOCK_RANGE : span / 2n;

    // A response-volume rejection says this REGION is dense, not that the
    // provider's block-range limit is lower — narrowing it globally would
    // permanently slow every later scan, so that one stays local.
    if (kind === 'range' && smaller < opts.window.maxRange) {
      if (++state.shrinks > MAX_SHRINKS_PER_SWEEP) throw err;
      opts.window.maxRange = smaller;
      opts.onShrink?.(span, smaller);
    } else if (kind === 'range' ? ++state.shrinks > MAX_SHRINKS_PER_SWEEP : volumeDepth >= MAX_SHRINKS_PER_SWEEP) {
      throw err;
    }

    let cursor = start;
    while (cursor <= end) {
      // A nested shrink may have narrowed the shared window further mid-walk.
      const chunkEnd = min(cursor + min(smaller, opts.window.maxRange) - 1n, end);
      // Independent dense regions each get a bounded bisection budget. A
      // successful region must not exhaust the next one's recovery budget.
      // Halvings above the default window are free: a 2M window that is too
      // dense halves (1M may fit) yet still reaches the narrow sizes.
      await fetchRange(opts, cursor, chunkEnd, out, state,
        volumeDepth + (kind === 'volume' && span <= DEFAULT_MAX_BLOCK_RANGE ? 1 : 0));
      cursor = chunkEnd + 1n;
    }
  }
}

// Public RPCs throttle: one Citrea state-leaf scan is 500+ calls at that
// chain's 1000-block cap, so a 429 partway through must not fail the
// withdrawal. Mirrors the SDK's own linear backoff, which the wrapper's
// plain-getLogs path would otherwise skip.
async function fetchWithRetry<T>(
  opts: SweepOptions<T>,
  start: bigint,
  end: bigint,
): Promise<T[]> {
  const wait = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let rateLimitRetries = 0;
  let headLagRetries = 0;
  for (;;) {
    try {
      return await opts.fetch(start, end);
    } catch (err) {
      if (isHeadLagError(err) && headLagRetries < MAX_HEAD_LAG_RETRIES) {
        await wait(HEAD_LAG_BACKOFF_MS * ++headLagRetries);
      } else if (isRateLimitError(err) && rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
        await wait(RATE_LIMIT_BACKOFF_MS * ++rateLimitRetries);
      } else {
        throw err;
      }
    }
  }
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
