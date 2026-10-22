/**
 * A `fetch` that goes over Tor, loaded only if someone asks for it.
 *
 * THROUGH ANON-RPC. The Tor client is an anon-rpc worker: the harness reads the
 * provider's specifier contract, downloads the bundle it names, runs it only if
 * its keccak256 matches the pinned hash, and does so in a null-origin sandboxed
 * iframe that cannot reach this page. Another anonymizing network is then a
 * different specifier (config/tor.ts TOR_PROVIDERS), not a different client.
 *
 * The harness is the ONLY reference to anon-rpc in this repo, a dynamic
 * `import()` inside a function called only after the user enables a provider
 * (and names a gateway if it needs one). The client is never in our bundle:
 * the harness fetches it from the specifier's resolvers.
 *
 * ONE READ GOES OUT DIRECT. Before the client exists, the harness reads the
 * specifier (two eth_calls to a public contract) through the bootstrap provider
 * below. They show that this browser is starting an anon-rpc client and nothing about the
 * user, and they still pass the egress allowlist.
 *
 * WHY IT RETURNS A FETCH. services/egress-transport.ts already threads a
 * `fetchFn` through to the sender, with the egress allowlist checked in front
 * of it. Handing it this function puts Tor UNDERNEATH that check rather than
 * around it: the allowlist still decides what may be sent, and Tor only
 * changes how the permitted request travels. Any other wiring would have made
 * Tor a way around the allowlist.
 *
 * FAILURE IS LOUD, NEVER SILENT. If the gateway is unreachable or the client
 * cannot start, this throws and the call fails. It does not fall back to a
 * direct fetch. A privacy toggle that quietly stops applying is worse than one
 * that visibly breaks, because the user carries on believing it.
 */

import {
  ACTIVE_TOR_SETTINGS,
  DEFAULT_TOR_PROVIDER,
  TOR_IN_FORCE,
  TOR_ON_DEVICE,
  torProvider,
  validateTorGatewayFor,
  type TorProvider,
  type TorProviderId,
} from '@/config/tor';
import { assertEgressAllowed } from '@/services/egress-policy';

/** The subset of the anon-rpc harness this app uses. */
type TorClientLike = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  close: () => void;
};

type AnonRpcWorkerLike = {
  ready: Promise<void>;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  close: () => void;
  acceptLog?: (options: { signal: AbortSignal }) => Promise<{ args: unknown[] }>;
};

/**
 * One client per page load, shared by every transport.
 *
 * The promise itself is cached, not its result, so several transports starting
 * at once wait on a single bootstrap rather than each building a circuit.
 */
let activeFetch: ReturnType<typeof createTorFetch> | null = null;

/** Thrown when Tor cannot be used, so the caller fails rather than leaks. */
export class TorUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TorUnavailableError';
  }
}

// React Native installs abort-controller 3.0.0 as AbortSignal, which has no
// throwIfAborted(), AbortSignal.timeout(), AbortSignal.any() or `reason`. On a
// device the first throwIfAborted() threw a TypeError, and every Test came back
// "Could not start the anon-rpc client". These use the platform versions where
// they exist and plain AbortController equivalents where they do not.
function abortReason(signal: AbortSignal): unknown {
  const reason = (signal as { reason?: unknown }).reason;
  if (reason !== undefined) return reason;
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  return composeSignals(signals).signal;
}

/**
 * anySignal with a way to let go. The fallback hangs a listener on every
 * input, and one input (a sender's lifetime) outlives every request, so a
 * per-request composition must be released or each RPC stays referenced for
 * the sender's life. The platform AbortSignal.any needs no release.
 */
function composeSignals(signals: AbortSignal[]): { signal: AbortSignal; release: () => void } {
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any(signals), release: () => {} };
  const controller = new AbortController();
  const detach: (() => void)[] = [];
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(abortReason(signal));
      break;
    }
    const onAbort = () => controller.abort(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    detach.push(() => signal.removeEventListener('abort', onAbort));
  }
  return { signal: controller.signal, release: () => detach.forEach((fn) => fn()) };
}

// A call made before the worker is ready is buffered, not cancelled. Race that
// wait here too, so a timed-out probe or RPC cannot send its request later.
function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * The EIP-1193-shaped provider the harness reads the specifier through.
 *
 * Direct on purpose: Tor is what it bootstraps, so it cannot ride Tor. It still
 * passes the egress allowlist, and it uses the endpoint in force for that
 * chain, so a user's own node serves it when they have set one.
 *
 * The specifier's chain may be missing from the app's chain list (plain
 * staging is Sepolia only, prod has no Sepolia, and Nox's specifier lives on
 * Sepolia), so a missing registry entry falls back to the user's override for
 * that chain, then ours. Same reads, same allowlist, whichever chain.
 *
 * Takes the bootstrap's signal: the harness stops booting on close() but
 * cannot cancel a read it has handed to this provider, so closing ends it here.
 */
async function bootstrapProvider(provider: TorProvider, signal: AbortSignal) {
  const { getChainConfig } = await import('@/config/chains');
  let url = getChainConfig(provider.specifierChainId)?.rpcUrl;
  if (!url && (provider.specifierChainId === 1 || provider.specifierChainId === 11155111)) {
    const { activeCustomRpcUrl } = await import('@/config/custom-rpc');
    const { MAINNET_RPC_URL, SEPOLIA_RPC_URL } = await import('@/config/env');
    url = activeCustomRpcUrl(provider.specifierChainId)
      ?? (provider.specifierChainId === 1 ? MAINNET_RPC_URL : SEPOLIA_RPC_URL);
  }
  if (!url) throw new TorUnavailableError('No endpoint to read the anon-rpc client specifier from.');
  const endpoint = url;
  let id = 0;
  return {
    async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
      const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] });
      const headers = { 'content-type': 'application/json' };
      assertEgressAllowed('rpc', { method: 'POST', url: endpoint, headers, body });
      const response = await fetch(endpoint, {
        method: 'POST', headers, body, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
      });
      if (!response.ok) throw new Error(`specifier read failed: HTTP ${response.status}`);
      const reply = await response.json() as { result?: unknown; error?: { message?: string } };
      if (reply.error) throw new Error(`specifier read failed: ${reply.error.message ?? 'RPC error'}`);
      if (isWorkerHashRead(provider, method, params) && !sameHash(reply.result, provider.workerHash)) {
        throw new TorUnavailableError('The anon-rpc client named on-chain is not the one this build accepts.');
      }
      return reply.result;
    },
  };
}

/** `workerHash()`, the read whose answer decides which code the harness runs. */
const WORKER_HASH_SELECTOR = '0x3898587d';

function isWorkerHashRead(provider: TorProvider, method: string, params: unknown[] | undefined): boolean {
  if (method !== 'eth_call') return false;
  const call = params?.[0] as { to?: unknown; data?: unknown; input?: unknown } | undefined;
  const data = typeof call?.data === 'string' ? call.data : typeof call?.input === 'string' ? call.input : '';
  return typeof call?.to === 'string' && call.to.toLowerCase() === provider.specifier.toLowerCase()
    && data.toLowerCase().startsWith(WORKER_HASH_SELECTOR);
}

function sameHash(result: unknown, pinned: string): boolean {
  // bytes32 comes back as exactly one 32-byte word.
  return typeof result === 'string' && result.toLowerCase() === pinned.toLowerCase();
}

/** What a Test is doing, in order, so the form can say more than "Checking". */
export type TorProbeStep = 'loading' | 'specifier' | 'starting' | 'directory' | 'relays' | 'circuit' | 'checking';

export const TOR_PROBE_STEP_TEXT: Record<TorProbeStep, string> = {
  loading: 'Loading anon-rpc',
  specifier: 'Reading the client from the chain',
  // A device runs Arti, not tor-js, and only ever reaches this step and the
  // last: the specifier and directory steps come from the web lane.
  starting: TOR_ON_DEVICE ? 'Starting Tor' : 'Starting the client',
  directory: 'Downloading the network directory',
  relays: 'Downloading the relay list',
  circuit: 'Building a circuit',
  checking: 'Checking the connection',
};

const STEP_ORDER: TorProbeStep[] = ['loading', 'specifier', 'starting', 'directory', 'relays', 'circuit', 'checking'];

/** tor-js's own bootstrap log lines, mapped to the step they mark. */
export function workerLogStep(line: string): TorProbeStep | null {
  if (/Fast bootstrap: fetching/.test(line)) return 'directory';
  if (/Looking for a consensus|Downloading microdescriptors/.test(line)) return 'relays';
  if (/enough information to build circuits|Bootstrap complete/.test(line)) return 'circuit';
  return null;
}

/**
 * Follow the worker's bootstrap while a Test runs, through the harness's
 * acceptLog(). Entries come from this worker alone, so a Test that overlaps
 * the app's own bootstrap never advances on its lines. Steps only move
 * forward, so a late line cannot rewind it.
 */
function followWorkerLog(worker: AnonRpcWorkerLike, report: (step: TorProbeStep) => void, signal: AbortSignal): () => void {
  const { acceptLog } = worker;
  if (typeof acceptLog !== 'function') return () => {};
  const stop = new AbortController();
  const both = anySignal([signal, stop.signal]);
  void (async () => {
    try {
      for (;;) {
        const { args } = await acceptLog.call(worker, { signal: both });
        const step = workerLogStep(args.map((a) => (typeof a === 'string' ? a : '')).join(' '));
        if (step) report(step);
      }
    } catch { /* closed, failed or stopped */ }
  })();
  return () => stop.abort();
}

async function loadClient(
  gatewayUrl: string,
  signal = timeoutSignal(TOR_PROBE_TIMEOUT_MS),
  providerId: TorProviderId = DEFAULT_TOR_PROVIDER,
  onStep?: (step: TorProbeStep) => void,
): Promise<TorClientLike> {
  let reached = -1;
  const report = (step: TorProbeStep) => {
    const at = STEP_ORDER.indexOf(step);
    if (at > reached) { reached = at; onStep?.(step); }
  };
  const provider = torProvider(providerId);
  if (!provider) throw new TorUnavailableError('That anon-rpc provider is not available in this build.');
  const gateway = validateTorGatewayFor(provider.id, gatewayUrl);
  if (!gateway.ok) throw new TorUnavailableError(gateway.message);
  report('loading');
  let module: { AnonRpcWorker?: unknown };
  try {
    // The only two references in the repo, both bare dynamic imports, so a
    // user who never turns anon-rpc on never loads either. On a device the
    // client is Arti compiled into the app (@0xbow/anon-rpc-rs-react-native,
    // AnonRpcWorker.tor()): same worker shape, no gateway, no specifier, no
    // bundle.
    module = await withAbort<{ AnonRpcWorker?: unknown }>(
      TOR_ON_DEVICE ? import('@0xbow/anon-rpc-rs-react-native') : import('@0xbow/anon-rpc-rs-browser-harness'),
      signal,
    );
  } catch (cause) {
    console.warn('[anon-rpc] client load failed', cause);
    throw new TorUnavailableError('Could not load the anon-rpc client.', { cause });
  }

  const factory = module.AnonRpcWorker as
    | ((new (init: unknown) => AnonRpcWorkerLike) & { tor?: () => AnonRpcWorkerLike })
    | undefined;
  if (typeof factory !== 'function' || (TOR_ON_DEVICE && typeof factory.tor !== 'function')) {
    throw new TorUnavailableError('The anon-rpc client does not expose the expected interface.');
  }

  let worker: AnonRpcWorkerLike | undefined;
  let unfollow: (() => void) | undefined;
  try {
    throwIfAborted(signal);
    if (TOR_ON_DEVICE) {
      worker = factory.tor!();
    } else {
      report('specifier');
      const rpcProvider = await withAbort(bootstrapProvider(provider, signal), signal);
      throwIfAborted(signal);
      worker = new factory({
        address: provider.specifier,
        config: provider.workerConfig(gateway.url),
        preExisting: { rpcProvider },
      });
    }
    // Only a Test follows the log: the app's own client leaves it alone.
    if (onStep) unfollow = followWorkerLog(worker, report, signal);
    report('starting');
    await withAbort(worker.ready, signal);
    const started = worker;
    return { fetch: (url, init) => started.fetch(url, init), close: () => started.close() };
  } catch (cause) {
    worker?.close();
    // Loud, so a device failure names its cause instead of only the message.
    console.warn('[anon-rpc] client start failed', cause);
    if (cause instanceof TorUnavailableError) throw cause;
    throw new TorUnavailableError('Could not start the anon-rpc client.', { cause });
  } finally {
    unfollow?.();
  }
}

/**
 * The Tor fetch for this page load, or null when Tor is not in force.
 *
 * Null rather than a passthrough, so a caller has to decide what to do about
 * it rather than receiving something that looks like Tor and is not.
 */
export function torFetchIfActive(): ((input: string | URL | Request, init?: RequestInit) => Promise<Response>) | null {
  if (!TOR_IN_FORCE) return null;
  return activeFetch ??= createTorFetch(ACTIVE_TOR_SETTINGS.gatewayUrl, ACTIVE_TOR_SETTINGS.provider);
}

/** Draft probes must use the selected gateway before settings take effect on reload. */
export function createTorFetch(gatewayUrl: string, providerId: TorProviderId = DEFAULT_TOR_PROVIDER) {
  let clientPromise: Promise<TorClientLike> | null = null;
  const lifetime = new AbortController();
  const send = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    // The fetch polyfill on React Native may leave Request.signal unset.
    const { signal, release } = composeSignals([init?.signal ?? request.signal, lifetime.signal].filter((s): s is AbortSignal => !!s));
    try {
      throwIfAborted(signal);
      clientPromise ??= loadClient(gatewayUrl, anySignal([timeoutSignal(TOR_PROBE_TIMEOUT_MS), lifetime.signal]), providerId);
      const pending = clientPromise;
      let client: TorClientLike;
      try {
        client = await withAbort(pending, signal);
      } catch (error) {
        // Let the next call try again rather than pinning the failure for the
        // rest of the session: a gateway that was down at page load may be up.
        if (!signal.aborted && clientPromise === pending) clientPromise = null;
        throw error;
      }
      // Buffered: the body crosses the sandbox boundary as bytes, and a JSON-RPC
      // body is small. Read through arrayBuffer(), never `request.body`: React
      // Native's Request (whatwg-fetch) has no `.body`, and gating on it sent
      // every RPC from a device with an empty body.
      const bytes = request.method === 'GET' || request.method === 'HEAD'
        ? null : new Uint8Array(await withAbort(request.arrayBuffer(), signal));
      const body = bytes && bytes.byteLength > 0 ? bytes : undefined;
      throwIfAborted(signal);
      // The harness ends a streamed body when this signal aborts, so a timeout
      // still ends a probe that has its headers but not its answer.
      return await withAbort(client.fetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body,
        signal,
      }), signal);
    } finally {
      // Where release does anything (React Native), the native client has
      // already buffered the whole response, so no body is left to abort.
      release();
    }
  };
  // Draft gateways must stop consuming circuits when the form closes or the
  // address changes, including a bootstrap that has not completed yet.
  return Object.assign(send, { close() {
    lifetime.abort(new TorUnavailableError('The anon-rpc connection was closed.'));
    void clientPromise?.then(client => client.close(), () => {});
  } });
}

/** For the form: check a provider before saving, without keeping the client. */
export async function probeTorGateway(
  gatewayUrl: string,
  timeoutMs = TOR_PROBE_TIMEOUT_MS,
  providerId: TorProviderId = DEFAULT_TOR_PROVIDER,
  onStep?: (step: TorProbeStep) => void,
  callerSignal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { signal, release } = composeSignals([
    timeoutSignal(timeoutMs), ...(callerSignal ? [callerSignal] : []),
  ]);
  let client: TorClientLike | undefined;
  try {
    client = await loadClient(gatewayUrl, signal, providerId, onStep);
    onStep?.('checking');
    throwIfAborted(signal);
    if (providerId !== 'tor-js') return await probeMixnet(client, signal);
    // check.torproject.org is the canonical "am I on Tor" endpoint and is the
    // library's own example, so it exercises a real circuit rather than just
    // the gateway handshake.
    const response = await withAbort(client.fetch('https://check.torproject.org/api/ip', { signal }), signal);
    if (!response.ok) return { ok: false, message: 'The Tor connection answered, but the check did not complete.' };
    const verdict = await withAbort(response.json(), signal);
    if (verdict?.IsTor !== true) return { ok: false, message: 'The connection check did not confirm a Tor exit.' };
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof TorUnavailableError ? error.message
        : !TOR_ON_DEVICE && providerId === 'tor-js' ? 'Could not reach that gateway.'
          : 'Could not reach the anon-rpc network.',
    };
  } finally {
    client?.close();
    release();
  }
}

/**
 * A mixnet has no "am I on Nym" endpoint, and asking check.torproject.org
 * would answer no. So the Test asks a public mainnet node for its chain id
 * through the client: a fixed, user-neutral call, the kind the client exists
 * to carry, and an answer only arrives if the network really relayed it.
 */
export const MIXNET_PROBE_URL = 'https://ethereum-rpc.publicnode.com';

async function probeMixnet(client: TorClientLike, signal: AbortSignal): Promise<{ ok: true } | { ok: false; message: string }> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
  const headers = { 'content-type': 'application/json' };
  assertEgressAllowed('rpc', { method: 'POST', url: MIXNET_PROBE_URL, headers, body });
  const response = await withAbort(client.fetch(MIXNET_PROBE_URL, { method: 'POST', headers, body, signal }), signal);
  if (!response.ok) return { ok: false, message: 'The network answered, but the call did not complete.' };
  const reply = await withAbort(response.json(), signal) as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown } | null;
  if (reply?.jsonrpc !== '2.0' || reply.id !== 1 || 'error' in reply || reply.result !== '0x1') {
    return { ok: false, message: 'The network did not return a valid answer.' };
  }
  return { ok: true };
}

/**
 * Building a circuit is slow; this is patience, not a health check.
 *
 * A cold start took 52s on the anon-rpc demo gateway (2026-09-30), because a
 * worker blob-spawned in the null-origin sandbox is not a secure context:
 * crypto.subtle is missing and tor-js falls back from its fast bootstrap to
 * downloading microdescriptors. Later starts reuse the worker's cached
 * directory.
 */
export const TOR_PROBE_TIMEOUT_MS = 120_000;
