/**
 * Everything the debug log records beyond what the app logs by name.
 *
 * Pat, 2026-09-24: "log every click, every action, every error, proof
 * generation, relayer answer, quotes, errors from quotes, time waiting from
 * quotes, everything". Clicks and field edits are the debug provider's own
 * clickstream. This adds, while debug mode is on:
 *
 * - console: every console.log/info/warn/error/debug line, which is where the
 *   app's flows ("[Transfer] RELAY SUBMITTED", proof and quote steps, "[perf]")
 *   and the SDK's logger (services/sdk-logger.ts) already report;
 * - errors: uncaught errors and unhandled promise rejections, with stacks;
 * - network: every fetch with method, URL, request body, status, time waited
 *   and the response body, so relayer answers, quotes and quote errors are all
 *   there with their timing. Bodies are truncated; RPC responses harder, they
 *   are large and frequent.
 *
 * Local only: it feeds the in-memory log that a recording or an export writes
 * to a file the user saves. Nothing is sent anywhere.
 *
 * No react-native imports, so it is bun-testable.
 */

export type CaptureLog = (level: 'debug' | 'info' | 'warn' | 'error', tag: string, message: string, data?: unknown) => void;

const REQUEST_BODY_LIMIT = 4_000;
const CONSOLE_PAYLOAD_LIMIT = 4_000;
const RESPONSE_BODY_LIMIT = 20_000;
const RPC_RESPONSE_LIMIT = 1_500;

export function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}… [+${text.length - limit} chars]` : text;
}

function bodyText(body: unknown): string | null {
  if (body == null) return null;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  return `[${Object.prototype.toString.call(body).slice(8, -1)}]`;
}

/** A JSON-RPC body's method(s), so an RPC line says what it asked. */
export function rpcMethods(text: string | null): string | null {
  if (!text || text[0] !== '{' && text[0] !== '[') return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const methods = list.map((m) => (m && typeof m === 'object' ? (m as { method?: unknown }).method : undefined)).filter((m): m is string => typeof m === 'string');
    return methods.length ? methods.join(',') : null;
  } catch {
    return null;
  }
}

function describeArg(a: unknown): unknown {
  if (a instanceof Error) return { name: a.name, message: a.message, stack: a.stack };
  return a;
}

/**
 * Console arguments as ONE truncated string, made at capture time. Keeping the
 * objects themselves pinned whatever a caller logged for the whole debug
 * session (review, 2026-09-24).
 */
export function consolePayload(args: readonly unknown[]): string {
  const seen = new WeakSet<object>();
  let text: string;
  try {
    text = JSON.stringify(args.map(describeArg), (_k, v) => {
      if (typeof v === 'bigint') return v.toString();
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
      }
      return v;
    }) ?? '';
  } catch {
    text = args.map((a) => String(a)).join(' ');
  }
  return truncate(text, CONSOLE_PAYLOAD_LIMIT);
}

// Our own writes to the console (the provider echoes every entry there) must
// not come back in as new entries.
let inCapture = false;

/** Run `fn` with console capture paused: for the logger's own console echo. */
export function uncaptured<T>(fn: () => T): T {
  const was = inCapture;
  inCapture = true;
  try { return fn(); } finally { inCapture = was; }
}

/** Install every capture; returns the uninstall. */
export function installDebugCapture(log: CaptureLog, target: typeof globalThis = globalThis): () => void {
  const undo: Array<() => void> = [];

  // Console.
  const levels = [['log', 'info'], ['info', 'info'], ['debug', 'debug'], ['warn', 'warn'], ['error', 'error']] as const;
  const con = target.console as unknown as Record<string, (...args: unknown[]) => void>;
  for (const [method, level] of levels) {
    const original = con[method];
    if (typeof original !== 'function') continue;
    const wrapper = (...args: unknown[]) => {
      original.apply(target.console, args);
      if (inCapture) return;
      inCapture = true;
      try {
        const [first, ...rest] = args;
        if (typeof first === 'string') {
          log(level, 'console', first, rest.length ? consolePayload(rest) : undefined);
        } else {
          log(level, 'console', '(object)', consolePayload(args));
        }
      } catch { /* capture must never break the caller */ } finally {
        inCapture = false;
      }
    };
    con[method] = wrapper;
    // Restore only what we installed: a wrapper added after ours stays.
    undo.push(() => { if (con[method] === wrapper) con[method] = original; });
  }

  // Uncaught errors and rejections.
  const win = target as unknown as { addEventListener?: (t: string, h: (e: unknown) => void) => void; removeEventListener?: (t: string, h: (e: unknown) => void) => void };
  if (typeof win.addEventListener === 'function') {
    const onError = (e: unknown) => {
      const ev = e as { message?: string; filename?: string; lineno?: number; error?: unknown };
      log('error', 'uncaught', ev.message ?? 'error', { source: ev.filename, line: ev.lineno, error: describeArg(ev.error) });
    };
    const onRejection = (e: unknown) => {
      const reason = (e as { reason?: unknown }).reason;
      log('error', 'unhandledrejection', reason instanceof Error ? reason.message : String(reason), describeArg(reason));
    };
    win.addEventListener('error', onError);
    win.addEventListener('unhandledrejection', onRejection);
    undo.push(() => {
      win.removeEventListener?.('error', onError);
      win.removeEventListener?.('unhandledrejection', onRejection);
    });
  }

  // Network.
  const originalFetch = target.fetch;
  if (typeof originalFetch === 'function') {
    let seq = 0;
    const fetchWrapper = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const id = ++seq;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      const method = (init?.method ?? (input as Request)?.method ?? 'GET').toUpperCase();
      const reqText = bodyText(init?.body);
      const rpc = rpcMethods(reqText);
      const started = Date.now();
      log('debug', 'net', `→ #${id} ${method} ${url}${rpc ? ` (${rpc})` : ''}`, reqText ? { body: truncate(reqText, REQUEST_BODY_LIMIT) } : undefined);
      try {
        const response = await originalFetch.call(target, input as RequestInfo, init);
        const waitedMs = Date.now() - started;
        let clone: Response | null = null;
        try { clone = response.clone(); } catch { clone = null; }
        if (clone) {
          clone.text()
            .then((text) => log(response.ok ? 'debug' : 'warn', 'net', `← #${id} ${response.status} ${method} ${url} in ${waitedMs}ms`, {
              waitedMs,
              status: response.status,
              body: truncate(text, rpc ? RPC_RESPONSE_LIMIT : RESPONSE_BODY_LIMIT),
            }))
            .catch(() => log('debug', 'net', `← #${id} ${response.status} ${method} ${url} in ${waitedMs}ms`, { waitedMs, status: response.status }));
        } else {
          log('debug', 'net', `← #${id} ${response.status} ${method} ${url} in ${waitedMs}ms`, { waitedMs, status: response.status });
        }
        return response;
      } catch (err) {
        log('error', 'net', `✕ #${id} ${method} ${url} failed after ${Date.now() - started}ms`, describeArg(err));
        throw err;
      }
    }) as typeof fetch;
    target.fetch = fetchWrapper;
    undo.push(() => { if (target.fetch === fetchWrapper) target.fetch = originalFetch; });
  }

  return () => { for (const u of undo.reverse()) u(); };
}
