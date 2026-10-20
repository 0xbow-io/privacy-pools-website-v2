/**
 * Network + phase tracing for the "why is my balance slow to load" question.
 *
 * Why a fetch wrapper and not per-callsite logging: the calls we need to count
 * are mostly NOT ours. viem's http() transport, the ASP api-client and the SDK's
 * own discovery all bottom out in `fetch`, and the expensive pattern we have hit
 * before was an N+1 *inside* the SDK (one getMerkleProof per note - 110
 * concurrent 376KB responses). Wrapping fetch once sees all of it, including
 * code we do not own, with no callsite churn.
 *
 * What it measures, per request: host, path, JSON-RPC method (parsed from the
 * body), duration, response size, ok/failed. Aggregated by (host, method) so a
 * repeated call shows up as a count, not 300 log lines. It also tracks PEAK
 * IN-FLIGHT requests, because request volume alone does not explain latency -
 * a public RPC that serialises 200 concurrent calls does.
 *
 * Safety: tracing never changes behaviour. Every hook is wrapped so a tracing
 * bug cannot fail a request, the sample buffer is capped, and the wrapper is
 * installed at most once.
 *
 * Reading it: a summary prints automatically once the network goes quiet after
 * a burst (see QUIET_MS), and `window.__ppv2Perf.report()` prints on demand -
 * that is the one to ask a user to run and paste.
 */

type Sample = {
  key: string;
  host: string;
  method: string;
  ms: number;
  bytes: number;
  ok: boolean;
  /** Caller frames, captured for the first few of each kind (see STACK_SAMPLES). */
  stack?: string;
};

type Agg = {
  key: string;
  count: number;
  totalMs: number;
  maxMs: number;
  bytes: number;
  failures: number;
};

const MAX_SAMPLES = 4000;
/**
 * How many call sites to capture per request kind. Counting a repeated request
 * tells you THAT there is an N+1; the stack tells you WHERE it is, which is the
 * whole question when the caller is inside a dependency. Capturing a stack is
 * not free, so only the first few of each kind pay for it.
 */
const STACK_SAMPLES = 3;
/** Network considered "settled" after this long with nothing in flight. */
const QUIET_MS = 1500;
/** Don't auto-report trivial bursts (a single poll shouldn't print a table). */
const AUTO_REPORT_MIN_REQUESTS = 12;

const samples: Sample[] = [];
/** Count of stacks captured per key, so attribution stays cheap. */
const stacksSeen = new Map<string, number>();
const phases = new Map<string, { startedAt: number; endedAt?: number; count: number }>();
let inFlight = 0;
let peakInFlight = 0;
let burstStartedAt = 0;
let burstRequests = 0;
let quietTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * Install guard on globalThis, not module scope: on web the module can be
 * evaluated more than once (multiple bundles, Fast Refresh), and a second
 * wrapper would double-count every request. The first run printed the banner
 * twice, which is exactly that.
 */
const INSTALL_FLAG = '__ppv2PerfInstalled';

/** JSON-RPC method from a request body, when the body is a JSON-RPC envelope. */
function rpcMethodOf(body: unknown): string | null {
  if (typeof body !== 'string' || body.length === 0 || body[0] !== '{' && body[0] !== '[') return null;
  try {
    const parsed = JSON.parse(body);
    // Batched JSON-RPC: name it by the methods it carries so a batch of 50
    // eth_calls is not mistaken for one cheap request.
    if (Array.isArray(parsed)) {
      const names = Array.from(new Set(parsed.map((p) => String(p?.method ?? '?'))));
      return `batch[${parsed.length}]:${names.join(',')}`;
    }
    const m = parsed?.method;
    return typeof m === 'string' ? m : null;
  } catch {
    return null;
  }
}

function urlOf(input: unknown): string {
  try {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    if (input && typeof input === 'object' && 'url' in input) return String((input as { url: unknown }).url);
  } catch {
    /* fall through */
  }
  return '(unknown)';
}

/** Collapse ids/hashes out of a path so /labels/0xabc… aggregates with its peers. */
function normalizePath(path: string): string {
  return path
    .replace(/0x[0-9a-fA-F]{6,}/g, '0x…')
    .replace(/\/\d{4,}/g, '/…');
}

function record(sample: Sample): void {
  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

function aggregate(from: Sample[]): Agg[] {
  const byKey = new Map<string, Agg>();
  for (const s of from) {
    const a = byKey.get(s.key) ?? { key: s.key, count: 0, totalMs: 0, maxMs: 0, bytes: 0, failures: 0 };
    a.count += 1;
    a.totalMs += s.ms;
    a.maxMs = Math.max(a.maxMs, s.ms);
    a.bytes += s.bytes;
    if (!s.ok) a.failures += 1;
    byKey.set(s.key, a);
  }
  return Array.from(byKey.values()).sort((x, y) => y.count - x.count || y.totalMs - x.totalMs);
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)}KB`;

/**
 * Print the report. `since` limits it to the current burst; omit for the
 * whole session. Safe to call any time.
 */
export function reportPerfTrace(since?: number): void {
  try {
    const scoped = since ? samples.filter((_, i) => i >= samples.length - burstRequests) : samples;
    if (scoped.length === 0) {
      console.log('[perf] no requests recorded yet');
      return;
    }
    const aggs = aggregate(scoped);
    const totalMs = scoped.reduce((n, s) => n + s.ms, 0);
    const totalBytes = scoped.reduce((n, s) => n + s.bytes, 0);
    const wall = since ? Date.now() - since : 0;
    const failures = scoped.filter((s) => !s.ok).length;

    console.log(
      `[perf] ${scoped.length} requests${wall ? ` over ${(wall / 1000).toFixed(1)}s wall` : ''}`
      + `, ${(totalMs / 1000).toFixed(1)}s summed latency, ${kb(totalBytes)} transferred`
      + `, peak ${peakInFlight} in flight${failures ? `, ${failures} failed` : ''}`,
    );
    // Grouped, so an N+1 reads as one line with a big count.
    for (const a of aggs.slice(0, 18)) {
      console.log(
        `[perf]   ${String(a.count).padStart(4)}x  ${a.key}`
        + `  total ${(a.totalMs / 1000).toFixed(1)}s  max ${a.maxMs.toFixed(0)}ms  ${kb(a.bytes)}`
        + `${a.failures ? `  FAILED ${a.failures}` : ''}`,
      );
    }
    if (aggs.length > 18) console.log(`[perf]   … ${aggs.length - 18} more request kinds`);

    // Attribution for the worst offenders: a big count is only actionable once
    // you know which code path emits it.
    for (const a of aggs.slice(0, 3)) {
      if (a.count < 5) continue;
      const withStack = scoped.find((s) => s.key === a.key && s.stack);
      if (withStack?.stack) console.log(`[perf]   ↳ ${a.key} called from: ${withStack.stack}`);
    }

    const done = Array.from(phases.entries()).filter(([, p]) => p.endedAt !== undefined);
    if (done.length) {
      console.log('[perf] phases:');
      for (const [name, p] of done.sort((a, b) => (b[1].endedAt! - b[1].startedAt) - (a[1].endedAt! - a[1].startedAt))) {
        console.log(`[perf]   ${name}: ${((p.endedAt! - p.startedAt) / 1000).toFixed(2)}s${p.count > 1 ? ` (${p.count} runs)` : ''}`);
      }
    }
    const open = Array.from(phases.entries()).filter(([, p]) => p.endedAt === undefined);
    for (const [name, p] of open) {
      console.log(`[perf]   ${name}: STILL RUNNING after ${((Date.now() - p.startedAt) / 1000).toFixed(1)}s`);
    }
  } catch (err) {
    console.log('[perf] report failed', err);
  }
}

/** Mark the start of a named phase (idempotent per name; re-start counts runs). */
export function perfPhaseStart(name: string): void {
  try {
    const existing = phases.get(name);
    phases.set(name, { startedAt: Date.now(), count: (existing?.count ?? 0) + 1 });
    console.log(`[perf] ▶ ${name}`);
  } catch { /* never throw from tracing */ }
}

/** Mark a named phase complete, logging its duration and any detail. */
export function perfPhaseEnd(name: string, detail?: string): void {
  try {
    const p = phases.get(name);
    if (!p) return;
    p.endedAt = Date.now();
    phases.set(name, p);
    console.log(`[perf] ■ ${name} ${((p.endedAt - p.startedAt) / 1000).toFixed(2)}s${detail ? ` — ${detail}` : ''}`);
  } catch { /* never throw from tracing */ }
}

/** One-shot counter for things that aren't requests (cache hits, notes seen). */
export function perfNote(message: string): void {
  try { console.log(`[perf] · ${message}`); } catch { /* ignore */ }
}

function scheduleQuietReport(): void {
  if (quietTimer) clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    quietTimer = null;
    if (inFlight > 0) return;
    if (burstRequests >= AUTO_REPORT_MIN_REQUESTS) {
      console.log(`[perf] ── network settled after ${burstRequests} requests ──`);
      reportPerfTrace(burstStartedAt);
    }
    burstRequests = 0;
    burstStartedAt = 0;
    peakInFlight = 0;
  }, QUIET_MS);
}

/**
 * Wrap global fetch to count and time every request. Idempotent, and a no-op
 * off web (native uses the same fetch, so it works there too, but the entry
 * point only installs it on web today).
 */
export function installNetworkTrace(): void {
  if ((globalThis as Record<string, unknown>)[INSTALL_FLAG]) return;
  if (typeof globalThis.fetch !== 'function') return;
  (globalThis as Record<string, unknown>)[INSTALL_FLAG] = true;

  const original = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async function tracedFetch(input: RequestInfo | URL, init?: RequestInit) {
    let key = '(untraced)';
    let host = '';
    let started = 0;
    let stack: string | undefined;
    try {
      const raw = urlOf(input);
      const u = (() => { try { return new URL(raw, typeof location !== 'undefined' ? location.href : undefined); } catch { return null; } })();
      host = u?.host ?? '(relative)';
      const rpc = rpcMethodOf(init?.body ?? (input as Request)?.body);
      key = rpc ? `${host} ${rpc}` : `${host}${normalizePath(u?.pathname ?? raw)}`;
      const seen = stacksSeen.get(key) ?? 0;
      if (seen < STACK_SAMPLES) {
        stacksSeen.set(key, seen + 1);
        stack = (new Error().stack ?? '')
          .split('\n')
          .slice(2, 9)
          .map((l) => l.trim())
          .filter((l) => !l.includes('perf-trace'))
          .join(' <- ');
      }
      started = Date.now();
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (burstStartedAt === 0) burstStartedAt = started;
      burstRequests += 1;
    } catch { /* tracing must not break the request */ }

    try {
      const response = await original(input as RequestInfo, init);
      try {
        // content-length is absent on chunked/compressed responses (the first
        // run reported 0KB for everything), so measure the real payload from a
        // clone. The clone leaves the caller's stream intact; we read it in the
        // background so we never delay the caller on the measurement.
        const clone = (() => { try { return response.clone(); } catch { return null; } })();
        const ms = Date.now() - started;
        if (clone) {
          clone.arrayBuffer()
            .then((buf) => record({ key, host, method: key, ms, bytes: buf.byteLength, ok: response.ok, stack }))
            .catch(() => record({ key, host, method: key, ms, bytes: 0, ok: response.ok, stack }));
        } else {
          record({ key, host, method: key, ms, bytes: Number(response.headers?.get?.('content-length')) || 0, ok: response.ok, stack });
        }
      } catch { /* ignore */ }
      return response;
    } catch (err) {
      try { record({ key, host, method: key, ms: Date.now() - started, bytes: 0, ok: false, stack }); } catch { /* ignore */ }
      throw err;
    } finally {
      try {
        inFlight = Math.max(0, inFlight - 1);
        if (inFlight === 0) scheduleQuietReport();
      } catch { /* ignore */ }
    }
  } as typeof fetch;

  try {
    (globalThis as Record<string, unknown>).__ppv2Perf = {
      report: () => reportPerfTrace(),
      reportBurst: () => reportPerfTrace(burstStartedAt || Date.now()),
      reset: () => { samples.length = 0; phases.clear(); peakInFlight = 0; burstRequests = 0; burstStartedAt = 0; },
      raw: () => ({ samples: samples.slice(), phases: Array.from(phases.entries()), peakInFlight }),
    };
    console.log('[perf] network tracing on. Run __ppv2Perf.report() for a summary.');
  } catch { /* ignore */ }
}

/** Test seam: aggregate a sample list exactly as the report does. */
export const __testables = { aggregate, rpcMethodOf, normalizePath };
