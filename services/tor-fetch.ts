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
import { TorUnavailableError } from '@/services/tor-errors';
import { beginTorOperation, noteTorQuotes, torGroupFor, type TorParty, type TorSubject } from '@/services/tor-groups';
import type * as BrowserHarness from '@0xbow/anon-rpc-rs-browser-harness';
import type * as NativeHarness from '@0xbow/anon-rpc-rs-react-native';

export { TorUnavailableError };

/** The harness: the browser package on the web, the native SDK's on a device. */
type Harness = typeof BrowserHarness | typeof NativeHarness;

/** A ReplacingWorker, or a WorkerPool group: a fetch over one route at a time. */
type TorClient = Pick<BrowserHarness.WorkerGroup, 'fetch' | 'close'>;

/** A fetch over Tor. */
export type TorFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// Race a wait that takes no signal (an import, a worker's `ready`, a provider
// read) against one, rejecting with the signal's own reason, as a harness call
// does, so every caller sees the reason it aborted with.
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
 * One provider per endpoint for the page: the harness shares a page's boot
 * reads between workers by provider, so every worker after the first starts
 * without reading anything direct. A read the harness no longer waits for
 * ends at TOR_PROBE_TIMEOUT_MS.
 */
async function bootstrapProvider(known: BrowserHarness.KnownWorker): Promise<BrowserHarness.RpcProvider> {
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
  let provider = bootstrapProviders.get(endpoint);
  if (!provider) bootstrapProviders.set(endpoint, provider = directProvider(endpoint));
  return provider;
}

const bootstrapProviders = new Map<string, BrowserHarness.RpcProvider>();

function directProvider(endpoint: string): BrowserHarness.RpcProvider {
  let id = 0;
  return {
    async request({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> {
      const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] });
      const headers = { 'content-type': 'application/json' };
      assertEgressAllowed('rpc', { method: 'POST', url: endpoint, headers, body });
      const { signal, release } = composeSignals([timeoutSignal(TOR_PROBE_TIMEOUT_MS)]);
      try {
        const response = await fetch(endpoint, {
          method: 'POST', headers, body, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal,
        });
        if (!response.ok) throw new Error(`specifier read failed: HTTP ${response.status}`);
        const reply = await response.json() as { result?: unknown; error?: { message?: string } };
        if (reply.error) throw new Error(`specifier read failed: ${reply.error.message ?? 'RPC error'}`);
        return reply.result;
      } finally {
        release();
      }
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
function followWorkerLog(worker: BrowserHarness.AnonRpcWorker, report: (step: TorProbeStep) => void, signal: AbortSignal): () => void {
  const stop = new AbortController();
  const both = anySignal([signal, stop.signal]);
  void (async () => {
    try {
      for (;;) {
        const { args } = await worker.acceptLog({ signal: both });
        const step = workerLogStep(args.map((a) => (typeof a === 'string' ? a : '')).join(' '));
        if (step) report(step);
      }
    } catch { /* closed, failed or stopped */ }
  })();
  return () => stop.abort();
}

async function importHarness(signal: AbortSignal): Promise<Harness> {
  try {
    // The only two runtime references in the repo, both bare dynamic imports,
    // so a user who never turns anon-rpc on never loads either. On a device the
    // client is Arti compiled into the app (@0xbow/anon-rpc-rs-react-native,
    // AnonRpcWorker.tor()): same worker shape, no gateway, no specifier, no
    // bundle.
    return await withAbort<Harness>(
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

/**
 * Providers whose specifier pins a bundle this build does not accept, and the
 * error each start then fails with. No retry gets past the pin until the
 * specifier or the build changes, so a refused provider starts nothing more
 * this session: no specifier read, no worker, no log line per call.
 */
const pinRefusals = new Map<TorProviderId, TorUnavailableError>();

/**
 * One web client, started and ready; `onStep` hears its steps after
 * 'loading'. A device's ReplacingWorker starts Arti itself.
 */
async function loadClient(
  module: typeof BrowserHarness,
  { provider, gatewayUrl }: ReturnType<typeof clientTarget>,
  signal: AbortSignal,
  onStep?: (step: TorProbeStep) => void,
): Promise<TorClient> {
  let reached = STEP_ORDER.indexOf('loading');
  const report = (step: TorProbeStep) => {
    const at = STEP_ORDER.indexOf(step);
    if (at > reached) { reached = at; onStep?.(step); }
  };

  const refusal = pinRefusals.get(provider.id);
  if (refusal) throw refusal;
  let worker: BrowserHarness.AnonRpcWorker | undefined;
  let unfollow: (() => void) | undefined;
  try {
    throwIfAborted(signal);
    report('specifier');
    const rpcProvider = await withAbort(bootstrapProvider(module.knownWorker(provider.id)), signal);
    throwIfAborted(signal);
    // The harness runs a bundle only if the specifier pins this build's hash,
    // and refuses before fetching it otherwise.
    worker = new module.AnonRpcWorker({
      ...module.knownWorkerInit(provider.id, { rpcProvider, config: provider.workerConfig(gatewayUrl) }),
      expectedWorkerHash: provider.workerHash,
    });
    // Only a Test follows the log: the app's own client leaves it alone.
    if (onStep) unfollow = followWorkerLog(worker, report, signal);
    report('starting');
    await withAbort(worker.ready, signal);
    const started = worker;
    return { fetch: (url, init) => started.fetch(url, init), close: () => started.close() };
  } catch (cause) {
    worker?.close();
    if ((cause as { name?: unknown } | null)?.name === 'WorkerHashMismatchError') {
      if (!pinRefusals.has(provider.id)) {
        pinRefusals.set(provider.id, new TorUnavailableError('The anon-rpc client named on-chain is not the one this build accepts.', { cause }));
        console.warn(`[anon-rpc] the ${provider.id} specifier pins a bundle this build does not accept; ${provider.id} stays off until reload`, cause);
      }
      throw pinRefusals.get(provider.id)!;
    }
    // Loud, so a device failure names its cause instead of only the message.
    console.warn('[anon-rpc] client start failed', cause);
    if (cause instanceof TorUnavailableError) throw cause;
    const skew = clockSkewError(cause);
    if (skew) throw skew;
    throw new TorUnavailableError('Could not start the anon-rpc client.', { cause });
  } finally {
    unfollow?.();
  }
}

/**
 * The Tor sender for a request to `party` whose URL and body are `text`, or
 * null when Tor is not in force.
 *
 * Null rather than a passthrough, so a caller has to decide what to do about
 * it rather than receiving something that looks like Tor and is not. Each
 * request goes over its isolation group's worker (services/tor-groups.ts),
 * chosen when this is called.
 */
export function torFetchFor(party: TorParty, text: string, subject?: TorSubject): TorFetch | null {
  if (!TOR_IN_FORCE) return null;
  const key = torGroupFor(party, text, subject);
  // A group of its own for one request: it closes once that request is done.
  if (key.startsWith('subject:')) return oneShotSender(key);
  let sender = senders.get(key);
  if (!sender) senders.set(key, sender = groupSender(key));
  return sender;
}

/**
 * A fetch for one party's requests: over anon-rpc, on the request's group,
 * when Tor is in force, and the global fetch otherwise. `about` says what a
 * request is about beyond its text, or `true` when it identifies the user
 * without naming an account (services/tor-groups.ts). For third-party clients
 * that take a fetch.
 */
export function routedFetch(
  party: TorParty,
  about?: (url: string, body: string) => TorSubject | boolean,
): TorFetch {
  return (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = typeof init?.body === 'string' ? init.body : '';
    const subject = about?.(url, body) ?? {};
    const send = torFetchFor(party, `${url}\n${body}`, typeof subject === 'boolean' ? { identifying: subject } : subject);
    return send ? send(input, init) : fetch(input, init);
  };
}

/** The sender for public chain reads, or null when Tor is not in force. */
export function torFetchIfActive(): TorFetch | null {
  return torFetchFor('rpc', '');
}

/**
 * Start an operation (see services/tor-groups.ts) and return what ends it.
 * Ending fails any request sent later through a sender it handed out, and
 * closes its worker, where it has one of its own, once the requests already
 * on their way are answered and read: a relay the relayer may have taken
 * still gets its answer when the flow closes first. Those get
 * TOR_RPC_TIMEOUT_MS from the end, body included, since the harness stops
 * timing a call once its headers arrive. The next operation starts on a fresh
 * route either way, under a new worker or a new isolation key.
 */
export function beginTorOperationScope(): () => void {
  const { key, end } = beginTorOperation();
  const operation: Operation = { ended: false, inFlight: 0, lifetime: new AbortController() };
  operations.set(key, operation);
  return () => {
    end();
    operation.ended = true;
    operations.delete(key);
    senders.delete(key);
    if (operation.inFlight === 0) closeGroup(key);
    else timeoutSignal(TOR_RPC_TIMEOUT_MS).addEventListener('abort', () => operation.lifetime.abort(operationEnded()), { once: true });
  };
}

/** One sender per group key, each over that group's worker. */
const senders = new Map<string, TorFetch>();

/**
 * An operation's state: whether it has ended, how many of its requests are on
 * their way, and the signal that ends those once the operation's grace runs out.
 */
type Operation = { ended: boolean; inFlight: number; lifetime: AbortController };

/** Each operation in progress, by group key, until it ends. */
const operations = new Map<string, Operation>();

const endedOperation = (): Operation => ({ ended: true, inFlight: 0, lifetime: new AbortController() });

function closeGroup(key: string): void {
  void groups?.then((group) => group(key).close(), () => {});
}

const operationEnded = () => new TorUnavailableError('The operation this request belonged to has ended.');

/**
 * The page's isolation groups, started on first use. A worker that isolates
 * by key (Arti on a device, tor-js on the web) carries every group, each
 * under an isolation key of its own: separate circuits and TLS sessions.
 * Otherwise a WorkerPool gives each group a worker of its own. The promise is
 * cached, not its result, so senders starting at once share one import; a
 * failed import is dropped so the next call tries again.
 */
let groups: Promise<Groups> | null = null;

/** Each group's client, and whether one worker carries every group by key. */
type Groups = ((key: string) => TorClient) & { keyed: boolean };

/**
 * How many workers the web pool keeps alive, over every group and the spare.
 * Each Nym client's cover traffic costs about a quarter of a 4-core Android
 * device even when idle, and four left no headroom for first calls; tor-js
 * workers slowed past four on Android and not through six on desktop
 * (2026-10-21/22). An idle client costs as much as a busy one, so idle groups
 * close.
 */
function workerBudget(provider: TorProviderId): { maxWorkers: number; spare: number; idleCloseMs: number } {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 0 ? navigator.hardwareConcurrency : 4;
  const maxWorkers = Math.min(6, Math.max(1, Math.floor(cores / 2)));
  return { maxWorkers, spare: maxWorkers >= 3 ? 1 : 0, idleCloseMs: provider === 'nym' ? 90_000 : 120_000 };
}

/**
 * Public groups merged to fit the web pool's budget: with six workers each
 * public service has its own, with four or five chain reads keep theirs and
 * the other services share one, and below that every public service shares
 * one. Identity groups always keep their own, and keyed groups have no
 * budget.
 */
function budgetedGroup(key: string): string {
  if (!key.startsWith('public:')) return key;
  const { maxWorkers } = workerBudget(ACTIVE_TOR_SETTINGS.provider);
  if (maxWorkers >= 6) return key;
  if (maxWorkers >= 4) return key === 'public:rpc' ? key : 'public';
  return 'public';
}

/**
 * One worker carries every group under its own isolation key where it can: a
 * device's Arti client does, and on the web a worker the harness knows to act
 * on `anonOptions.isolationKey` (anon-rpc §9.3).
 */
async function startGroups(): Promise<Groups> {
  const target = clientTarget(ACTIVE_TOR_SETTINGS.provider, ACTIVE_TOR_SETTINGS.gatewayUrl);
  const module = await importHarness(new AbortController().signal);
  const timeouts = { callTimeoutMs: TOR_ROUTE_DEADLINE_MS, readyTimeoutMs: TOR_PROBE_TIMEOUT_MS };
  const keyed = (replacing: AnonFetcher) =>
    Object.assign((key: string) => ({ fetch: keyedFetch(module, replacing, key), close: () => {} }), { keyed: true });
  if (TOR_ON_DEVICE) return keyed(new (module as typeof NativeHarness).ReplacingWorker({ start: { tor: {} }, ...timeouts }));
  const web = module as typeof BrowserHarness;
  const start = async (retired: AbortSignal) => ({ ...await loadClient(web, target, retired), ready: Promise.resolve() });
  if (web.knownWorker(target.provider.id).isolatesByKey) return keyed(new web.ReplacingWorker({ start, ...timeouts }));
  const pool = new web.WorkerPool({
    start,
    ...timeouts,
    ...workerBudget(target.provider.id),
  });
  return Object.assign((key: string) => pool.group(budgetedGroup(key)), { keyed: false });
}

/**
 * The isolation key a group's requests carry. A group moves to a new key, and
 * so to a new circuit, when its circuit's exit fails, by the harness's
 * isTorExitFailure on the `torKind` tor-js and the native Tor client report:
 * Arti keeps handing out a circuit whose exit stopped opening streams until it expires
 * as dirty, ten minutes on, so retrying on the same key fails the same way
 * (https://gitlab.torproject.org/tpo/core/arti/-/issues/1001). tor-js leaves
 * this to the application, and gives it `torKind` to decide by.
 */
function isolationKeyFor(group: string): string {
  const moves = circuitMoves.get(group);
  return moves ? `${group}~${moves}` : group;
}

function moveToNewCircuit(group: string): void {
  circuitMoves.set(group, (circuitMoves.get(group) ?? 0) + 1);
}

/**
 * `replacing`'s fetch for `group`, under the group's isolation key. An exit
 * failure moves the group to a new key; a call whose exit failed goes once
 * more.
 */
function keyedFetch(module: Harness, replacing: AnonFetcher, group: string): TorClient['fetch'] {
  return async (url, init) => {
    const send = () => replacing.fetch(url, { ...init, anonOptions: { isolationKey: isolationKeyFor(group) } })
      .catch((error: unknown) => {
        if (module.isTorExitFailure(error)) moveToNewCircuit(group);
        throw error;
      });
    try {
      return await send();
    } catch (error) {
      // An aborted call rejects with its caller's reason, untouched.
      if (init?.signal?.aborted) throw error;
      if (!module.isTorExitFailure(error)) throw clockSkewError(error) ?? error;
      return send();
    }
  };
}

/** A ReplacingWorker, which takes the harness's per-call options (anon-rpc §9.3). */
type AnonFetcher = { fetch: BrowserHarness.AnonFetch };

/** How many times each group has moved to a new circuit. */
const circuitMoves = new Map<string, number>();

function groupSender(key: string): TorFetch {
  const operation = key.startsWith('operation:') ? operations.get(key) ?? endedOperation() : undefined;
  const send: TorFetch = (input, init) => {
    const refusal = pinRefusals.get(ACTIVE_TOR_SETTINGS.provider);
    if (refusal) return Promise.reject(refusal);
    return sendOver(() => {
      const pending = groups ??= startGroups();
      return { pending, drop: () => { if (groups === pending) groups = null; } };
    }, key, input, init, operation?.lifetime.signal);
  };
  if (!operation) return send;
  // An operation's sender sends until the operation ends; one that ended
  // before its sender was made has nothing left to send. It reads each answer
  // before handing it on, so a relayer quote binds the relay that later names
  // its commitment to this operation, and the worker stays open until then.
  return async (input, init) => {
    if (operation.ended) throw operationEnded();
    operation.inFlight++;
    try {
      return await read(key, await send(input, init));
    } finally {
      if (--operation.inFlight === 0 && operation.ended) closeGroup(key);
    }
  };
}

/**
 * The response with its body read, after recording any relayer quote in it
 * (services/tor-groups.ts). An operation's and a one-shot group's answers are
 * small JSON.
 */
async function read(key: string, response: Response): Promise<Response> {
  const body = await response.arrayBuffer();
  noteTorQuotes(key, new TextDecoder().decode(body));
  return new Response(body.byteLength > 0 ? body : null, {
    status: response.status, statusText: response.statusText, headers: response.headers,
  });
}

/**
 * A sender for one request on a group of its own, which closes the group once
 * the response is in hand. The body is read first, since closing the group
 * ends a body still arriving; a request that identifies the user on its own
 * expects a small answer.
 */
function oneShotSender(key: string): TorFetch {
  const send = groupSender(key);
  return async (input, init) => {
    try {
      return await read(key, await send(input, init));
    } finally {
      void groups?.then((group) => group(key).close(), () => {});
    }
  };
}

/**
 * One request over a client: the request is rebuilt from its parts, since the
 * body crosses the sandbox boundary as bytes and a JSON-RPC body is small.
 * `clients` yields the pending client source and how to drop it when it fails
 * to load, so the next call tries again.
 */
async function sendOver(
  clients: () => { pending: Promise<(key: string) => TorClient>; drop: () => void },
  key: string,
  input: string | URL | Request,
  init: RequestInit | undefined,
  lifetime?: AbortSignal,
): Promise<Response> {
  const request = new Request(input, init);
  // The fetch polyfill on React Native may leave Request.signal unset.
  const { signal, release } = composeSignals([init?.signal ?? request.signal, lifetime].filter((s): s is AbortSignal => !!s));
  try {
    throwIfAborted(signal);
    const { pending, drop } = clients();
    let client: TorClient;
    try {
      client = (await withAbort(pending, signal))(key);
    } catch (error) {
      // The harness module failed to load: let the next call try again.
      if (!signal.aborted) drop();
      throw error;
    }
    // Read through arrayBuffer(), never `request.body`: React Native's Request
    // (whatwg-fetch) has no `.body`, and gating on it sent every RPC from a
    // device with an empty body.
    const bytes = request.method === 'GET' || request.method === 'HEAD'
      ? null : new Uint8Array(await withAbort(request.arrayBuffer(), signal));
    const body = bytes && bytes.byteLength > 0 ? bytes : undefined;
    throwIfAborted(signal);
    // The harness fails the call with this signal's reason when it aborts, and
    // ends a streamed body, so a timeout still ends a probe that has its
    // headers but not its answer.
    return await client.fetch(request.url, {
      method: request.method,
      headers: torHeaders(request.headers),
      body,
      redirect: init?.redirect ?? request.redirect,
      signal,
    });
  } finally {
    // Where release does anything (React Native), the native client has
    // already buffered the whole response, so no body is left to abort.
    release();
  }
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
 * A specifier that pins a bundle this build refuses is the exception: no
 * retry passes the pin, so the provider stays refused (pinRefusals).
 *
 * `onStep` follows each client's start, for a Test, which also learns when a
 * client is ready ('checking').
 */
async function replacingClient(
  gatewayUrl: string,
  providerId: TorProviderId,
  signal: AbortSignal,
  onStep?: (step: TorProbeStep) => void,
): Promise<TorClient> {
  const target = clientTarget(providerId, gatewayUrl);
  onStep?.('loading');
  const module = await importHarness(signal);
  const timeouts = { callTimeoutMs: TOR_ROUTE_DEADLINE_MS, readyTimeoutMs: TOR_PROBE_TIMEOUT_MS };
  if (TOR_ON_DEVICE) {
    // The native SDK starts Arti itself: the Test can name the start and the
    // ready, not the steps between.
    onStep?.('starting');
    const replacing = new (module as typeof NativeHarness).ReplacingWorker({ start: { tor: {} }, ...timeouts });
    const send = keyedFetch(module, replacing, draftKey());
    return {
      fetch: async (url, init) => {
        const response = await send(url, init);
        onStep?.('checking');
        return response;
      },
      close: () => replacing.close(),
    };
  }
  const web = module as typeof BrowserHarness;
  const replacing = new web.ReplacingWorker({
    start: async (retired) => {
      const { signal: boot, release } = composeSignals([signal, retired]);
      try {
        const client = await loadClient(web, target, boot, onStep);
        onStep?.('checking');
        throwIfAborted(boot);
        return { ...client, ready: Promise.resolve() };
      } finally {
        release();
      }
    },
    ...timeouts,
  });
  return { fetch: keyedFetch(module, replacing, draftKey()), close: () => replacing.close() };
}

/**
 * A draft's or Test's client. When it names the provider and gateway in force
 * and the page has started its client, or is starting it, it rides that one,
 * since another would bootstrap a second Tor client on the same stored state;
 * closing it then closes nothing. Otherwise it is a client of its own, which
 * closing ends. Either way it sends under a key of its own, which an exit
 * failure moves to a new circuit, as a group's does.
 */
async function draftClient(
  gatewayUrl: string,
  providerId: TorProviderId,
  signal: AbortSignal,
  onStep?: (step: TorProbeStep) => void,
): Promise<TorClient> {
  const draft = validateTorGatewayFor(providerId, gatewayUrl);
  const active = validateTorGatewayFor(ACTIVE_TOR_SETTINGS.provider, ACTIVE_TOR_SETTINGS.gatewayUrl);
  const page = TOR_IN_FORCE && providerId === ACTIVE_TOR_SETTINGS.provider && draft.ok && active.ok
    && draft.url === active.url ? groups : null;
  if (page) {
    const group = await withAbort(page, signal);
    onStep?.('checking');
    // A pool gives each group a worker of its own: public reads share one.
    return { fetch: group(group.keyed ? draftKey() : 'public:rpc').fetch, close: () => {} };
  }
  return replacingClient(gatewayUrl, providerId, signal, onStep);
}

let draftKeys = 0;
const draftKey = () => `draft:${++draftKeys}`;

/**
 * A Tor request's headers without the caller's User-Agent. A device sends
 * none; the web sends an empty one, which keeps the pinned tor-js worker from
 * adding the browser's, since that would tell this user's isolation keys apart
 * by browser, version and platform.
 */
function torHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out = Object.fromEntries(new Headers(headers).entries());
  delete out['user-agent'];
  return TOR_ON_DEVICE ? out : { ...out, 'user-agent': '' };
}

/**
 * A client start that Arti reports blocked by the device clock, as an error
 * the user can act on; null for any other failure.
 */
function clockSkewError(error: unknown): TorUnavailableError | null {
  const kind = (e: unknown) => (e as { torKind?: unknown } | null | undefined)?.torKind;
  if (kind(error) !== 'ClockSkew' && kind((error as { cause?: unknown } | null | undefined)?.cause) !== 'ClockSkew') return null;
  return new TorUnavailableError("Tor could not start because this device's date and time are wrong. Correct them and try again.", { cause: error });
}

/**
 * Draft probes must use the selected gateway before settings take effect on reload.
 *
 * Its clients come and go as replacingClient describes. Closing this sender
 * closes the one in use and counts for nothing.
 */
export function createTorFetch(gatewayUrl: string, providerId: TorProviderId = DEFAULT_TOR_PROVIDER) {
  let clients: Promise<TorClient> | null = null;
  const lifetime = new AbortController();
  const send: TorFetch = (input, init) => sendOver(() => {
    const pending = clients ??= draftClient(gatewayUrl, providerId, lifetime.signal);
    return {
      pending: pending.then((client) => () => client),
      drop: () => { if (clients === pending) clients = null; },
    };
  }, '', input, init, lifetime.signal);
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
  let clients: TorClient | undefined;
  try {
    clients = await draftClient(gatewayUrl, providerId, signal, onStep);
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

async function probeMixnet(clients: TorClient, signal: AbortSignal): Promise<{ ok: true } | { ok: false; message: string }> {
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
async function probeFetch(clients: TorClient, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await clients.fetch(url, { ...init, headers: torHeaders(init.headers), signal });
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
