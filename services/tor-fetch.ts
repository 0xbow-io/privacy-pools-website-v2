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
 * ONE READ GOES OUT DIRECT. Before each client starts, the harness checks the
 * chain and reads the specifier (eth_chainId, then two eth_calls to a public
 * contract) through the bootstrap provider below. They show that this browser
 * is starting an anon-rpc client and nothing about the user, and they still
 * pass the egress allowlist.
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
import { abortReason, anySignal, composeSignals, throwIfAborted, timeoutSignal } from '@/services/abort-signal';
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

type RpcProviderLike = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> };

/** The harness's knownWorker() entry: where a provider's specifier lives. */
type KnownWorkerLike = { specifier: string; specifierChainId: number };

/** The harness's ReplacingWorker, as this app constructs it. */
type ReplacingWorkerLike = TorClientLike;

type ReplacingWorkerFactory = new (options: {
  start: (signal: AbortSignal) => Promise<TorClientLike & { ready: Promise<void> }>;
  callTimeoutMs?: number;
}) => ReplacingWorkerLike;

type HarnessModule = {
  AnonRpcWorker?: unknown;
  ReplacingWorker?: unknown;
  knownWorker?: (id: TorProviderId) => KnownWorkerLike;
  knownWorkerInit?: (id: TorProviderId, options: { rpcProvider: RpcProviderLike; config?: unknown }) => object;
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

// Race a wait that takes no signal (an import, a worker's `ready`, a provider
// read) against one, rejecting with the signal's own reason; harness calls get
// it too, so every caller sees the reason it aborted with.
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
 * that chain, then ours. Same reads, same allowlist, whichever chain. The
 * harness checks this endpoint's eth_chainId against the specifier's chain
 * before it reads.
 *
 * Takes the bootstrap's signal: the harness stops booting on close() but
 * cannot cancel a read it has handed to this provider, so closing ends it here.
 */
async function bootstrapProvider(known: KnownWorkerLike, signal: AbortSignal) {
  const { getChainConfig } = await import('@/config/chains');
  let url = getChainConfig(known.specifierChainId)?.rpcUrl;
  if (!url && (known.specifierChainId === 1 || known.specifierChainId === 11155111)) {
    const { activeCustomRpcUrl } = await import('@/config/custom-rpc');
    const { MAINNET_RPC_URL, SEPOLIA_RPC_URL } = await import('@/config/env');
    url = activeCustomRpcUrl(known.specifierChainId)
      ?? (known.specifierChainId === 1 ? MAINNET_RPC_URL : SEPOLIA_RPC_URL);
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
      return reply.result;
    },
  };
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

async function importHarness(signal: AbortSignal): Promise<HarnessModule> {
  try {
    // The only two references in the repo, both bare dynamic imports, so a
    // user who never turns anon-rpc on never loads either. On a device the
    // client is Arti compiled into the app (@0xbow/anon-rpc-rs-react-native,
    // AnonRpcWorker.tor()): same worker shape, no gateway, no specifier, no
    // bundle.
    return await withAbort<HarnessModule>(
      TOR_ON_DEVICE ? import('@0xbow/anon-rpc-rs-react-native') : import('@0xbow/anon-rpc-rs-browser-harness'),
      signal,
    );
  } catch (cause) {
    console.warn('[anon-rpc] client load failed', cause);
    throw new TorUnavailableError('Could not load the anon-rpc client.', { cause });
  }
}

/** The provider and its gateway, checked before anything loads. */
function clientTarget(providerId: TorProviderId, gatewayUrl: string): { provider: TorProvider; gatewayUrl: string } {
  const provider = torProvider(providerId);
  if (!provider) throw new TorUnavailableError('That anon-rpc provider is not available in this build.');
  const gateway = validateTorGatewayFor(provider.id, gatewayUrl);
  if (!gateway.ok) throw new TorUnavailableError(gateway.message);
  return { provider, gatewayUrl: gateway.url };
}

/** One client, started and ready; `onStep` hears its steps after 'loading'. */
async function loadClient(
  module: HarnessModule,
  { provider, gatewayUrl }: ReturnType<typeof clientTarget>,
  signal: AbortSignal,
  onStep?: (step: TorProbeStep) => void,
): Promise<TorClientLike> {
  let reached = STEP_ORDER.indexOf('loading');
  const report = (step: TorProbeStep) => {
    const at = STEP_ORDER.indexOf(step);
    if (at > reached) { reached = at; onStep?.(step); }
  };

  const factory = module.AnonRpcWorker as
    | ((new (init: unknown) => AnonRpcWorkerLike) & { tor?: () => AnonRpcWorkerLike })
    | undefined;
  const { knownWorker, knownWorkerInit } = module;
  if (typeof factory !== 'function' || (TOR_ON_DEVICE ? typeof factory.tor !== 'function'
    : typeof knownWorker !== 'function' || typeof knownWorkerInit !== 'function')) {
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
      const rpcProvider = await withAbort(bootstrapProvider(knownWorker!(provider.id), signal), signal);
      throwIfAborted(signal);
      // The harness runs a bundle only if the specifier pins this build's hash,
      // and refuses before fetching it otherwise.
      worker = new factory({
        ...knownWorkerInit!(provider.id, { rpcProvider, config: provider.workerConfig(gatewayUrl) }),
        expectedWorkerHash: provider.workerHash,
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
    if ((cause as { name?: unknown } | null)?.name === 'WorkerHashMismatchError') {
      throw new TorUnavailableError('The anon-rpc client named on-chain is not the one this build accepts.', { cause });
    }
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

/**
 * The timeout an app RPC call gets: the caller's, raised to TOR_RPC_TIMEOUT_MS
 * while Tor carries the call.
 *
 * The first call to a host over Tor pays for a cold route: name resolution,
 * then TCP and TLS, all across the network. On Android Chrome with Nym that
 * took 16 to 35 s per host, and 3 to 17 s with Arti on a device, where a
 * direct call takes well under one (2026-10-17). A 5 or 10 s timeout aborts
 * every such call, viem's retries queue the same cold calls again, and on a
 * slower client that backlog never clears: in a five-minute run on Android not
 * one call completed. A warm route answers in about a second, so the longer
 * bound only matters while a route is being built.
 */
export function rpcTimeoutMs(configured: number | undefined): number | undefined {
  return TOR_IN_FORCE ? Math.max(configured ?? 0, TOR_RPC_TIMEOUT_MS) : configured;
}

/**
 * Clients for one sender: the harness's ReplacingWorker starts the first on
 * the first call and a new one, which picks a new route, once the one in use
 * stops carrying calls. A Nym client keeps the route it picks at boot, and 7
 * of 79 boots (2026-10-19) drew one that failed every call: an exit that
 * accepted the connection and then carried nothing, or a route on which every
 * TLS handshake to the endpoint broke off. A worker that has failed stays
 * failed too (anon-rpc §5, §7).
 *
 * A call that fails counts against the route, and so does one still waiting
 * TOR_ROUTE_DEADLINE_MS after its client is ready, since a route that hangs is
 * as dead as one that fails. One its caller aborts counts for nothing, which
 * is why that deadline falls inside the app's own timeout (rpcTimeoutMs). An
 * answer of any status shows the route works. A client that fails to start
 * is dropped, so the next call tries again rather than the failure staying
 * pinned for the rest of the session: a gateway down at page load may be up.
 *
 * `onStep` follows each client's start, for a Test, which also learns when a
 * client is ready ('checking').
 */
async function replacingClient(
  gatewayUrl: string,
  providerId: TorProviderId,
  signal: AbortSignal,
  onStep?: (step: TorProbeStep) => void,
): Promise<ReplacingWorkerLike> {
  const target = clientTarget(providerId, gatewayUrl);
  onStep?.('loading');
  const module = await importHarness(signal);
  const Replacing = module.ReplacingWorker as ReplacingWorkerFactory | undefined;
  if (typeof Replacing !== 'function') {
    throw new TorUnavailableError('The anon-rpc client does not expose the expected interface.');
  }
  return new Replacing({
    start: async (retired) => {
      const { signal: boot, release } = composeSignals([timeoutSignal(TOR_PROBE_TIMEOUT_MS), signal, retired]);
      try {
        const client = await loadClient(module, target, boot, onStep);
        onStep?.('checking');
        throwIfAborted(boot);
        return { ...client, ready: Promise.resolve() };
      } finally {
        release();
      }
    },
    callTimeoutMs: TOR_ROUTE_DEADLINE_MS,
  });
}

/**
 * Draft probes must use the selected gateway before settings take effect on reload.
 *
 * Its clients come and go as replacingClient describes. Closing this sender
 * closes the one in use and counts for nothing.
 */
export function createTorFetch(gatewayUrl: string, providerId: TorProviderId = DEFAULT_TOR_PROVIDER) {
  let clients: Promise<ReplacingWorkerLike> | null = null;
  const lifetime = new AbortController();
  const send = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    // The fetch polyfill on React Native may leave Request.signal unset.
    const { signal, release } = composeSignals([init?.signal ?? request.signal, lifetime.signal].filter((s): s is AbortSignal => !!s));
    try {
      throwIfAborted(signal);
      const pending = clients ??= replacingClient(gatewayUrl, providerId, lifetime.signal);
      let replacing: ReplacingWorkerLike;
      try {
        replacing = await withAbort(pending, signal);
      } catch (error) {
        // The harness module failed to load: let the next call try again.
        if (!signal.aborted && clients === pending) clients = null;
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
      return await withAbort(replacing.fetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body,
        redirect: init?.redirect ?? request.redirect,
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
    void clients?.then(client => client.close(), () => {});
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
  let clients: ReplacingWorkerLike | undefined;
  try {
    clients = await replacingClient(gatewayUrl, providerId, signal, onStep);
    if (providerId !== 'tor-js') return await probeMixnet(clients, signal);
    // check.torproject.org is the canonical "am I on Tor" endpoint and is the
    // library's own example, so it exercises a real circuit rather than just
    // the gateway handshake.
    const response = await probeFetch(clients, 'https://check.torproject.org/api/ip', {}, signal);
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
    clients?.close();
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

async function probeMixnet(clients: ReplacingWorkerLike, signal: AbortSignal): Promise<{ ok: true } | { ok: false; message: string }> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] });
  const headers = { 'content-type': 'application/json' };
  assertEgressAllowed('rpc', { method: 'POST', url: MIXNET_PROBE_URL, headers, body });
  const response = await probeFetch(clients, MIXNET_PROBE_URL, { method: 'POST', headers, body }, signal);
  if (!response.ok) return { ok: false, message: 'The network answered, but the call did not complete.' };
  const reply = await withAbort(response.json(), signal) as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown } | null;
  if (reply?.jsonrpc !== '2.0' || reply.id !== 1 || 'error' in reply || reply.result !== '0x1') {
    return { ok: false, message: 'The network did not return a valid answer.' };
  }
  return { ok: true };
}

/**
 * A Test's request, retried after a transport failure while its deadline
 * lasts; a client that fails to start ends the Test.
 *
 * A client that fails its first call is likely to fail every call, and
 * `clients` replaces it at that failure (see replacingClient), so the retry
 * goes out on a new route. Reporting the first failure would call a working
 * network unreachable. An attempt unanswered TOR_ROUTE_DEADLINE_MS after its
 * client is ready has failed too, as it would in the app. An answer, valid or
 * not, is never retried, and its body is read under the Test's own deadline.
 */
async function probeFetch(clients: ReplacingWorkerLike, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withAbort(clients.fetch(url, { ...init, signal }), signal);
    } catch (error) {
      // A client that could not start is not retried: a gateway that is down
      // or a pin the chain does not match fails the same way again.
      if (signal.aborted || attempt >= PROBE_ATTEMPTS || error instanceof TorUnavailableError) throw error;
    }
  }
}

const PROBE_ATTEMPTS = 3;

/**
 * Building a circuit is slow; this is patience, not a health check.
 *
 * On Android Chrome a cold tor-js start answered its first call 28 to 66 s
 * after page load, most of it the directory download from the demo gateway,
 * which varied from 3 to 48 s (2026-10-21). Later starts read the worker's
 * stored directory instead, in 2 to 5 s.
 *
 * A Test also has to outlast one dead route and the client that replaces it.
 * On Android Chrome a Nym client on a dead route failed its first call 72 to
 * 75 s after the Test began, one that hangs is given up at
 * TOR_ROUTE_DEADLINE_MS, and a new client answered in a median 29 s and at
 * most 61 s (2026-10-19).
 */
export const TOR_PROBE_TIMEOUT_MS = 180_000;

/** See rpcTimeoutMs. The slowest call that still answered took 52 s. */
export const TOR_RPC_TIMEOUT_MS = 90_000;

/**
 * How long a call may go unanswered once its client is ready before it counts
 * against the client's route (see replacingClient). Inside TOR_RPC_TIMEOUT_MS,
 * so it ends a hung call before the app's own timeout, which counts for
 * nothing, gives up on it.
 */
export const TOR_ROUTE_DEADLINE_MS = 85_000;
